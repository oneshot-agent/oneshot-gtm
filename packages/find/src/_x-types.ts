/** Shared shapes for the x-reposters finder (ported from the x-amplifiers pack). */

/** A watched X account whose reposters we harvest. */
export interface XSeed {
  handle: string;
  /**
   * Founder-authored line on why this seed's audience matters — the analog of
   * github-stars' `repoEdge`. Surfaced to the founder-lane prompt as optional
   * framing context; never sent verbatim.
   */
  edge?: string;
}

/** A tweet from a seed account that we harvested reposters from. */
export interface SeedTweet {
  id: string;
  seed: string;
  text: string;
  url: string;
  createdAt: string;
  retweets: number;
}

/**
 * Two reasons to contact someone off the same harvest.
 * `amplifier` — big enough, on-topic enough, to boost the launch. Ask: a repost.
 * `founder` — could actually run the product. Ask: does this fit how you work.
 */
export type XLane = "amplifier" | "founder";

/** A user as X returns them on retweeted_by / quote_tweets expansions. */
export interface XUser {
  id: string;
  username: string;
  name: string;
  description: string;
  location?: string;
  verified?: boolean;
  createdAt?: string;
  followers: number;
  following: number;
  tweetCount: number;
  /**
   * Whether we could DM them. Engine semantics differ: xapi's
   * `receives_your_dm` is per-relationship truth; twitterapi.io's `canDm`
   * means "accepts DMs from anyone" — payloads carry the engine name so the
   * hand-sender knows which question was answered.
   */
  dmOpen: boolean;
  /** The link in their bio, expanded. A founder signal. */
  site?: string;
  /** Every expanded link on the profile — website field plus links in the bio. */
  links: string[];
  /** Provider's own bot flag, where it has one. Better than our tweets/day guess. */
  automated?: boolean;
  /** Protected accounts can't be reached at all. */
  protected?: boolean;
  /**
   * Transient: the text of THEIR quote tweet, set only on users returned by a
   * `quoteTweets` call (it is per-tweet, not per-profile). The harvest copies
   * it onto the matching hit; read it from `XHit.quoteText` downstream.
   */
  quoteText?: string;
}

/** A seed tweet someone amplified, plus HOW they amplified that tweet. */
export interface XHit extends SeedTweet {
  mode: "retweet" | "quote";
  /** Their quote-tweet text when mode is "quote" — the strongest draft hook. */
  quoteText?: string;
}

/** One reposter, merged across every seed tweet they showed up on this run. */
export interface XCandidate {
  user: XUser;
  /** Seed tweets they reposted, newest first. */
  hits: XHit[];
  /** How they amplified across all hits: a plain repost, a quote, or both. */
  modes: ("retweet" | "quote")[];
}

export interface XScoredCandidate {
  candidate: XCandidate;
  /** The lane this row is being contacted in — it sets the ask. */
  lane: XLane;
  /** Every lane they qualified for, so the note can say "also an amplifier". */
  lanes: XLane[];
  score: number;
  /** Human-readable one-liner for why this score. */
  why: string;
}
