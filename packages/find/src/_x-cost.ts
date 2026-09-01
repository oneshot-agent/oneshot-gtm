/**
 * What an X harvest costs, counted as it happens.
 *
 * Both providers bill per *resource returned*, not per request — one
 * `retweeted_by` page of 100 users is 100 billable reads. A day of filter
 * tuning against the live X API once cost ~$12 and emptied the account, so the
 * meter is not optional: every engine reports what it pulled, and the run
 * stops at a ceiling.
 */

export type XEngineName = "twitterapiio" | "xapi";

export interface XRates {
  /** Per user profile returned. */
  user: number;
  /** Per post/tweet returned. */
  post: number;
  /** Floor charged even when a request returns nothing. */
  minRequest: number;
}

/**
 * twitterapi.io: $0.18/1k user profiles, $0.15/1k tweets, $0.00015 minimum.
 * X API v2: $0.010/user, $0.005/post (docs.x.com/x-api/getting-started/pricing).
 */
export const X_RATES: Record<XEngineName, XRates> = {
  twitterapiio: { user: 0.00018, post: 0.00015, minRequest: 0.00015 },
  xapi: { user: 0.01, post: 0.005, minRequest: 0 },
};

export class SpendExceeded extends Error {}

export class CostMeter {
  users = 0;
  posts = 0;
  requests = 0;
  private engine: XEngineName;
  private ceiling: number;

  constructor(engine: XEngineName, ceiling: number) {
    this.engine = engine;
    this.ceiling = ceiling;
  }

  get rates(): XRates {
    return X_RATES[this.engine];
  }

  /** Record one call's billable output. Throws once the run is too expensive. */
  charge(opts: { users?: number; posts?: number }): void {
    this.requests++;
    this.users += opts.users ?? 0;
    this.posts += opts.posts ?? 0;
    if (this.total > this.ceiling) {
      throw new SpendExceeded(
        `spend ceiling hit: ${this.format()} > ${money(this.ceiling)} — stopping, keeping what we have`,
      );
    }
  }

  get total(): number {
    const r = this.rates;
    return Math.max(this.requests * r.minRequest, this.users * r.user + this.posts * r.post);
  }

  /** What the next call could cost at worst, so we can stop before making it. */
  wouldExceed(users: number, posts = 0): boolean {
    const r = this.rates;
    return this.total + users * r.user + posts * r.post > this.ceiling;
  }

  format(): string {
    return `${money(this.total)} (${this.users} users, ${this.posts} posts, ${this.requests} requests)`;
  }
}

export function money(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Worst-case cost of a planned harvest, for the line logged before it runs. */
export function estimateHarvestCost(
  engine: XEngineName,
  opts: { seeds: number; tweetsPerSeed: number; perTweet: number },
): number {
  const r = X_RATES[engine];
  const tweets = opts.seeds * opts.tweetsPerSeed;
  // Per seed: a timeline page. Per tweet: reposters + quoters, both user-bearing.
  const timelinePosts = opts.seeds * 20;
  const users = tweets * opts.perTweet * 2;
  return timelinePosts * r.post + users * r.user + tweets * 2 * r.minRequest;
}
