/**
 * The four X reads the x-reposters finder needs, behind one interface so the
 * provider is a config line rather than a rewrite. Every engine returns the
 * shared `XUser` shape, so scoring and the finder never learn which provider
 * ran.
 */

import type { CostMeter, XEngineName } from "./_x-cost.ts";
import type { SeedTweet, XUser } from "./_x-types.ts";

export type FetchLike = typeof fetch;

/** Stop the run but keep what was harvested: rate limit, quota, spend ceiling. */
export class BudgetExhausted extends Error {}

export interface HarvestEngine {
  readonly name: string;
  /** Billing counter, shared with the caller so it can report the total. */
  readonly meter: CostMeter;
  /** Resolve a seed handle to an id, or null if the account is gone. */
  resolveUser(handle: string): Promise<XUser | null>;
  /** Recent original posts worth harvesting reposters from. */
  recentTweets(userId: string, seedHandle: string): Promise<SeedTweet[]>;
  /** Plain reposters of a post. */
  retweetedBy(tweetId: string): Promise<XUser[]>;
  /** Quote-reposters — never included in `retweetedBy`. */
  quoteTweets(tweetId: string): Promise<XUser[]>;
  /**
   * Optional second pass filling fields the bulk endpoints omit. Mutates the
   * users in place. Only called for candidates that survived the cheap drops.
   */
  enrich?(users: XUser[]): Promise<void>;
}

/** Every harvest dial, injected into engines instead of a module config. */
export interface HarvestKnobs {
  /** Seed tweets to pull reposters from, per seed account. */
  tweetsPerSeed: number;
  /** Only look at seed tweets this fresh. */
  sinceHours: number;
  /** A seed tweet below this many reposts isn't worth a call. */
  minRetweets: number;
  /**
   * Users pulled per source per tweet. Billing is per resource returned, so
   * this dial IS the cost. On the xapi engine it is also the literal
   * `max_results` param (X caps it at 100).
   */
  maxPerTweet: number;
  /**
   * retweeted_by + quote_tweets share a 75-per-15-minute window on the X
   * engine. Stop short so a manual re-run in the same window still works.
   */
  maxLookupCalls: number;
  /** Don't re-harvest a tweet paid for within this many hours. */
  skipHarvestedWithinHours: number;
}

/**
 * Per-engine defaults. The xapi knobs are deliberately tighter than the pack's
 * — first-party reads cost $0.01/user, and the pack's knobs price a full run
 * at $12.59 there vs ~$0.24 on twitterapi.io.
 */
export const DEFAULT_KNOBS: Record<XEngineName, HarvestKnobs> = {
  xapi: {
    tweetsPerSeed: 3,
    sinceHours: 48,
    minRetweets: 3,
    maxPerTweet: 25,
    maxLookupCalls: 60,
    skipHarvestedWithinHours: 96,
  },
  twitterapiio: {
    tweetsPerSeed: 5,
    sinceHours: 48,
    minRetweets: 3,
    maxPerTweet: 50,
    maxLookupCalls: 60,
    skipHarvestedWithinHours: 96,
  },
};

/** Default X read spend ceiling per run, per engine (USD). */
export const DEFAULT_MAX_SPEND: Record<XEngineName, number> = {
  xapi: 5,
  twitterapiio: 1,
};

/** Freshness + repost filters shared by every engine. */
export function usableTweets(
  raw: { id: string; text: string; createdAt: string; retweets: number }[],
  seedHandle: string,
  opts: { sinceHours: number; minRetweets: number; limit: number },
): SeedTweet[] {
  const cutoff = Date.now() - opts.sinceHours * 3600_000;
  return raw
    .map(
      (t): SeedTweet => ({
        id: t.id,
        seed: seedHandle,
        text: (t.text ?? "").trim(),
        url: `https://x.com/${seedHandle}/status/${t.id}`,
        createdAt: t.createdAt,
        retweets: t.retweets,
      }),
    )
    .filter((t) => t.retweets >= opts.minRetweets && Date.parse(t.createdAt) >= cutoff)
    .toSorted((a, b) => b.retweets - a.retweets)
    .slice(0, opts.limit);
}
