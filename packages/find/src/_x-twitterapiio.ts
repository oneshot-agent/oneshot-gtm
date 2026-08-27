/**
 * twitterapi.io engine — the opt-in alternative, ~55x cheaper than the
 * first-party API ($0.18/1k user profiles vs $0.010 each) and it returns a
 * superset of the fields we use, including `canDm` and `isAutomated`.
 *
 * It is a third-party scraper, not a licensed reseller. That is a deliberate
 * trade for cost; the first-party engine stays the default.
 */

import { CostMeter } from "./_x-cost.ts";
import {
  BudgetExhausted,
  usableTweets,
  type FetchLike,
  type HarvestEngine,
  type HarvestKnobs,
} from "./_x-engine.ts";
import type { SeedTweet, XUser } from "./_x-types.ts";

const BASE = "https://api.twitterapi.io";

/**
 * `canDm` reads as "accepts DMs from anyone" rather than X's per-relationship
 * `receives_your_dm`. For cold outreach to strangers that is the more useful
 * question; measured against 26 handles the X engine had answered for, the two
 * agreed 26/26 — but payloads still carry the engine name to keep them apart.
 */
export function mapTwitterApiIoUser(u: any): XUser {
  // The retweeters endpoint returns a *reduced* user (no entities, no
  // isAutomated, `url` left as a raw t.co). The batch/profile endpoints return
  // the full object with `entities` at the top level — and the docs show it
  // nested under `profile_bio`. Read all three shapes.
  const entities = u.entities ?? u.profile_bio?.entities ?? {};
  const links = [...(entities.url?.urls ?? []), ...(entities.description?.urls ?? [])]
    .map((l: any) => l.expanded_url ?? l.display_url ?? "")
    .filter(Boolean);

  return {
    id: String(u.id ?? ""),
    username: u.userName ?? u.screen_name ?? "",
    name: u.name ?? u.userName ?? "",
    description: (u.description ?? u.profile_bio?.description ?? "").trim(),
    location: u.location,
    verified: u.isBlueVerified === true || u.isVerified === true,
    createdAt: u.createdAt,
    followers: u.followers ?? 0,
    following: u.following ?? 0,
    tweetCount: u.statusesCount ?? 0,
    dmOpen: u.canDm === true,
    automated: u.isAutomated === true,
    protected: u.protected === true,
    site: links[0],
    links,
  };
}

function mapTweet(t: any) {
  return {
    id: String(t.id ?? ""),
    text: t.text ?? "",
    createdAt: t.createdAt ?? new Date().toISOString(),
    retweets: t.retweetCount ?? t.retweet_count ?? 0,
  };
}

export class TwitterApiIoEngine implements HarvestEngine {
  readonly name = "twitterapiio";
  readonly meter: CostMeter;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly knobs: HarvestKnobs;

  constructor(opts: { meter: CostMeter; knobs: HarvestKnobs; apiKey?: string; fetch?: FetchLike }) {
    this.apiKey = opts.apiKey ?? process.env["TWITTERAPI_IO_KEY"] ?? "";
    if (!this.apiKey) {
      throw new Error("TWITTERAPI_IO_KEY is not set — needed for the twitterapi.io engine");
    }
    this.fetchImpl = opts.fetch ?? fetch;
    this.meter = opts.meter;
    this.knobs = opts.knobs;
  }

  private async get(path: string, params: Record<string, string | number>): Promise<any> {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    const res = await this.fetchImpl(`${BASE}/${path}?${qs}`, {
      headers: { "X-API-Key": this.apiKey },
    });
    const body = await res.text();
    if (!res.ok || /credits? is not enough/i.test(body)) {
      // Out of credits is a stop, not a crash — the partial harvest still writes.
      if (res.status === 401 || res.status === 402 || /credits/i.test(body)) {
        throw new BudgetExhausted(`twitterapi.io ${path}: ${body.slice(0, 160)}`);
      }
      throw new Error(`twitterapi.io ${path} failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return JSON.parse(body);
  }

  /**
   * Walk cursor pages up to `max` users, stopping early if the next page would
   * push the run past its ceiling.
   */
  private async pagedUsers(
    path: string,
    tweetId: string,
    max: number,
    pick: (json: any) => any[],
  ): Promise<XUser[]> {
    const out: XUser[] = [];
    let cursor = "";
    while (out.length < max) {
      if (this.meter.wouldExceed(Math.min(100, max - out.length))) {
        throw new BudgetExhausted(`spend ceiling would be exceeded fetching ${path}`);
      }
      const json = await this.get(path, cursor ? { tweetId, cursor } : { tweetId });
      const rows = pick(json) ?? [];
      this.meter.charge({ users: rows.length });
      out.push(...rows.map(mapTwitterApiIoUser).filter((u) => u.username));
      if (!json.has_next_page || !json.next_cursor || rows.length === 0) break;
      cursor = json.next_cursor;
    }
    return out.slice(0, max);
  }

  /**
   * Reduced rows from `retweeters` carry no links and no bot flag, so the
   * founder lane and the GitHub gate can never fire on them. Re-fetch the full
   * profile for candidates that survived the cheap drops — a few hundred users
   * at $0.00018 each, cents, and only for people still in the running.
   */
  async enrich(users: XUser[]): Promise<void> {
    const ids = users.map((u) => u.id).filter(Boolean);
    const byId = new Map(users.map((u) => [u.id, u]));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      if (this.meter.wouldExceed(chunk.length)) {
        throw new BudgetExhausted("spend ceiling would be exceeded enriching candidates");
      }
      const json = await this.get("twitter/user/batch_info_by_ids", { userIds: chunk.join(",") });
      const rows: any[] = json?.users ?? json?.data ?? [];
      this.meter.charge({ users: rows.length });
      for (const row of rows) {
        const target = byId.get(String(row.id ?? ""));
        if (!target) continue;
        const full = mapTwitterApiIoUser(row);
        // Keep what the reduced row already told us; fill in what it couldn't.
        target.links = full.links;
        target.site = full.site;
        target.automated = full.automated;
        target.verified = full.verified;
        if (full.description) target.description = full.description;
      }
    }
  }

  async resolveUser(handle: string): Promise<XUser | null> {
    const json = await this.get("twitter/user/info", { userName: handle });
    this.meter.charge({ users: json?.data ? 1 : 0 });
    return json?.data ? mapTwitterApiIoUser(json.data) : null;
  }

  async recentTweets(_userId: string, seedHandle: string): Promise<SeedTweet[]> {
    const json = await this.get("twitter/user/last_tweets", { userName: seedHandle });
    const raw: any[] = json?.data?.tweets ?? json?.tweets ?? [];
    this.meter.charge({ posts: raw.length });
    const originals = raw.filter((t) => !t.isReply && !t.retweeted_tweet);
    return usableTweets(originals.map(mapTweet), seedHandle, {
      sinceHours: this.knobs.sinceHours,
      minRetweets: this.knobs.minRetweets,
      limit: this.knobs.tweetsPerSeed,
    });
  }

  async retweetedBy(tweetId: string): Promise<XUser[]> {
    return this.pagedUsers(
      "twitter/tweet/retweeters",
      tweetId,
      this.knobs.maxPerTweet,
      (j) => j.users,
    );
  }

  async quoteTweets(tweetId: string): Promise<XUser[]> {
    // Quotes come back as tweets; the author is the person we want.
    const out: XUser[] = [];
    let cursor = "";
    const max = this.knobs.maxPerTweet;
    while (out.length < max) {
      if (this.meter.wouldExceed(20, 20)) {
        throw new BudgetExhausted("spend ceiling would be exceeded fetching quotes");
      }
      const json = await this.get(
        "twitter/tweet/quotes",
        cursor ? { tweetId, cursor } : { tweetId },
      );
      const rows: any[] = json?.tweets ?? [];
      this.meter.charge({ posts: rows.length, users: rows.length });
      for (const t of rows) {
        const author = t.author ?? t.user;
        // Billed for the quote post anyway — keep its text for THEIR_QUOTE.
        if (author) {
          const mapped = mapTwitterApiIoUser(author);
          out.push(t.text ? { ...mapped, quoteText: t.text } : mapped);
        }
      }
      if (!json.has_next_page || !json.next_cursor || rows.length === 0) break;
      cursor = json.next_cursor;
    }
    return out.filter((u) => u.username).slice(0, max);
  }
}
