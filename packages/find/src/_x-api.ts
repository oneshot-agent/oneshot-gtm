/**
 * First-party X API v2 engine — the default. OAuth1 user-context, with a call
 * budget baked in.
 *
 * Observed limits (user-context OAuth1, probed 2026-08-27):
 *   /2/users/by/username/:h      plenty
 *   /2/users/:id/tweets          900 / 15min
 *   /2/tweets/:id/retweeted_by   75 / 15min  (shared window with quote_tweets)
 *   /2/tweets/:id/quote_tweets   75 / 15min  (shared window with retweeted_by)
 *   /2/tweets/:id/liking_users   returns result_count: 0 — X killed it, unusable
 */

import { CostMeter } from "./_x-cost.ts";
import {
  BudgetExhausted,
  usableTweets,
  type FetchLike,
  type HarvestEngine,
  type HarvestKnobs,
} from "./_x-engine.ts";
import { loadXCreds, oauth1Header, queryString, type XCreds } from "./_x-oauth1.ts";
import type { SeedTweet, XUser } from "./_x-types.ts";

const DEFAULT_API_BASE = "https://api.twitter.com/2";

/** What we ask for on every user payload. `entities` carries the profile link. */
const USER_FIELDS =
  "public_metrics,description,location,verified,created_at,receives_your_dm,entities";

function mapUser(u: any): XUser {
  const m = u.public_metrics ?? {};
  return {
    // `receives_your_dm` is relationship data — it needs the user-context auth
    // we already use, and costs nothing extra on these calls.
    dmOpen: u.receives_your_dm === true,
    automated: undefined,
    site: u.entities?.url?.urls?.[0]?.expanded_url,
    // Links inside the bio text as well as the website field — a GitHub URL is
    // the cleanest available proof that someone builds things.
    links: [...(u.entities?.url?.urls ?? []), ...(u.entities?.description?.urls ?? [])]
      .map((l: any) => l.expanded_url ?? l.display_url ?? "")
      .filter(Boolean),
    id: u.id,
    username: u.username,
    name: u.name ?? u.username,
    description: (u.description ?? "").trim(),
    location: u.location,
    verified: u.verified,
    createdAt: u.created_at,
    followers: m.followers_count ?? 0,
    following: m.following_count ?? 0,
    tweetCount: m.tweet_count ?? 0,
  };
}

export class XApiEngine implements HarvestEngine {
  name = "xapi";
  meter: CostMeter;
  knobs: HarvestKnobs;
  private creds: XCreds;
  private fetchImpl: FetchLike;
  private apiBase: string;
  /** retweeted_by + quote_tweets calls made this run. */
  private lookups = 0;
  /** Lowest x-rate-limit-remaining seen on a lookup endpoint. */
  lastRemaining: number | null = null;

  constructor(opts: {
    meter: CostMeter;
    knobs: HarvestKnobs;
    creds?: XCreds;
    fetch?: FetchLike;
    apiBase?: string;
  }) {
    this.creds = opts.creds ?? loadXCreds();
    this.fetchImpl = opts.fetch ?? fetch;
    this.meter = opts.meter;
    this.knobs = opts.knobs;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  }

  get lookupsUsed(): number {
    return this.lookups;
  }

  private async get(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<any> {
    const qs = queryString(params);
    const url = `${this.apiBase}${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: oauth1Header(this.creds, "GET", url) },
    });
    const remaining = res.headers.get("x-rate-limit-remaining");
    if (remaining !== null) this.lastRemaining = Number(remaining);
    if (res.status === 429) throw new BudgetExhausted(`429 on ${path} — rate limited, stopping`);
    // 402 is the monthly read quota on the X tier, not a rate limit — it does
    // not clear in fifteen minutes. Stop the run and keep what we harvested.
    if (res.status === 402) {
      throw new BudgetExhausted(
        `402 on ${path} — X API credits depleted for this billing period, stopping`,
      );
    }
    if (!res.ok) {
      throw new Error(`X ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  /** One lookup-budget unit. Throws BudgetExhausted rather than burning the window. */
  private spendLookup(): void {
    if (this.lookups >= this.knobs.maxLookupCalls) {
      throw new BudgetExhausted(`hit the ${this.knobs.maxLookupCalls}-call lookup cap`);
    }
    if (this.lastRemaining !== null && this.lastRemaining <= 1) {
      throw new BudgetExhausted("x-rate-limit-remaining is exhausted");
    }
    this.lookups++;
  }

  /** X caps max_results at 100 on the lookup endpoints; past that it 400s. */
  private get perTweet(): number {
    return Math.min(this.knobs.maxPerTweet, 100);
  }

  async resolveUser(handle: string): Promise<XUser | null> {
    const json = await this.get(`/users/by/username/${handle}`, {
      "user.fields": "public_metrics,description,created_at",
    });
    this.meter.charge({ users: json?.data ? 1 : 0 });
    return json?.data ? mapUser(json.data) : null;
  }

  /** Recent original posts (no retweets, no replies) worth harvesting. */
  async recentTweets(userId: string, seedHandle: string): Promise<SeedTweet[]> {
    const json = await this.get(`/users/${userId}/tweets`, {
      max_results: 20,
      exclude: "retweets,replies",
      "tweet.fields": "created_at,public_metrics",
    });
    const raw = json?.data ?? [];
    this.meter.charge({ posts: raw.length });
    return usableTweets(
      raw.map((t: any) => ({
        id: t.id,
        text: t.text ?? "",
        createdAt: t.created_at ?? new Date().toISOString(),
        retweets: t.public_metrics?.retweet_count ?? 0,
      })),
      seedHandle,
      {
        sinceHours: this.knobs.sinceHours,
        minRetweets: this.knobs.minRetweets,
        limit: this.knobs.tweetsPerSeed,
      },
    );
  }

  /** Up to the 100 most recent plain reposters of a tweet. Single page — no cursor here. */
  async retweetedBy(tweetId: string): Promise<XUser[]> {
    this.spendLookup();
    const json = await this.get(`/tweets/${tweetId}/retweeted_by`, {
      max_results: this.perTweet,
      "user.fields": USER_FIELDS,
    });
    const rows = json?.data ?? [];
    this.meter.charge({ users: rows.length });
    return rows.map(mapUser);
  }

  /** Quote-reposters — retweeted_by does not include them. */
  async quoteTweets(tweetId: string): Promise<XUser[]> {
    this.spendLookup();
    const json = await this.get(`/tweets/${tweetId}/quote_tweets`, {
      max_results: this.perTweet,
      expansions: "author_id",
      "user.fields": USER_FIELDS,
    });
    const rows = json?.includes?.users ?? [];
    const posts: any[] = json?.data ?? [];
    this.meter.charge({ posts: posts.length, users: rows.length });
    // We are billed for the quote posts either way — keep their text: it is
    // the strongest personalization hook the drafts have (THEIR_QUOTE).
    const textByAuthor = new Map<string, string>();
    for (const t of posts) {
      const author = String(t?.author_id ?? "");
      if (author && t?.text && !textByAuthor.has(author)) textByAuthor.set(author, t.text);
    }
    return rows.map((u: any) => {
      const mapped = mapUser(u);
      const text = textByAuthor.get(mapped.id);
      return text ? { ...mapped, quoteText: text } : mapped;
    });
  }
}
