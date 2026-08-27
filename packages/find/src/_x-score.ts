/**
 * Lane assignment, hard drops and the 0-100 score for the x-reposters finder.
 * Pure functions — no I/O, no clock except what's passed in, so the whole
 * ranking is unit-testable.
 *
 * Two different questions get asked of the same harvest:
 *   amplifier — would this person plausibly boost a launch tweet from a
 *               stranger? Reach past a few hundred thousand scores *worse*,
 *               because those accounts don't repost strangers.
 *   founder   — could this person actually run the product? Reach barely
 *               matters; what they've shipped does.
 */

import type { XCandidate, XLane, XScoredCandidate, XUser } from "./_x-types.ts";

export interface XDropContext {
  /** The seed accounts themselves — lowercase handles. */
  seeds: Set<string>;
  /** Handles we never want contacted: our own accounts. */
  blocked: Set<string>;
}

/** Hard drops that apply in every lane, before scoring and before SDK spend. */
export const X_DROPS = {
  /** following/followers above this is a follow-farm, not an audience. */
  maxFollowRatio: 8,
  /** Tweets per day since account creation. Above this is automation. */
  maxTweetsPerDay: 150,
  bioSpam:
    /follow ?back|f4f|follow4follow|engagement (group|pod)|giveaway|dm for promo|promo my|cheap followers/i,
} as const;

export interface XLaneConfig {
  minFollowers: number;
  minTopicHits: number;
  /** A link in the bio that isn't a promo page. Something shipped beats something described. */
  requiresSite: boolean;
  /** A GitHub link satisfies the topic gate on its own — it's proof, not a hint. */
  requiresDevSignal: boolean;
  keywords: string[];
  weights: { reach: number; reciprocity: number; habit: number; topic: number };
}

/**
 * Two lanes over the same harvest. A candidate can qualify for both; the
 * founder lane wins, because a founder who could *use* the thing is worth more
 * than one more repost. The lanes disagree about follower count on purpose:
 * a founder under 1k is the median user — gating them on reach would throw
 * away the whole point.
 */
export const X_LANES: Record<XLane, XLaneConfig> = {
  amplifier: {
    /**
     * The win condition is adoption by people who build, and that comes from
     * audience composition, not follower count — measured on AI-influencer
     * seeds: 0 of 214 reposters had a GitHub link in bio. So the floor is low
     * and the gate moves to evidence they build things.
     */
    minFollowers: 1_000,
    minTopicHits: 2,
    requiresSite: false,
    requiresDevSignal: true,
    keywords: [
      "dev",
      "developer",
      "engineer",
      "programmer",
      "swe",
      "backend",
      "frontend",
      "fullstack",
      "devops",
      "rust",
      "python",
      "typescript",
      "javascript",
      "golang",
      "react",
      "open source",
      "oss",
      "maintainer",
      "contributor",
      "cli",
      "api",
      "infra",
      "agent",
      "llm",
      "ai",
      "build",
      "ship",
      "code",
      "coding",
      "hacker",
      "indie",
      "founder",
      "startup",
      "saas",
    ],
    weights: { reach: 0.2, reciprocity: 0.15, habit: 0.25, topic: 0.4 },
  },
  founder: {
    /** Low, not zero — under this the bio signal is usually aspirational. */
    minFollowers: 300,
    /** Two hits, because "founder" alone is the most-claimed word on X. */
    minTopicHits: 2,
    requiresSite: true,
    requiresDevSignal: false,
    keywords: [
      "founder",
      "cofounder",
      "ceo",
      "cto",
      "build",
      "ship",
      "shipping",
      "indie",
      "bootstrapped",
      "solo",
      "yc",
      "startup",
      "saas",
      "dev tool",
      "open source",
      "oss",
      "agent",
      "llm",
      "ai",
    ],
    weights: { reach: 0.05, reciprocity: 0.15, habit: 0.2, topic: 0.6 },
  },
};

/**
 * Hosts that make a bio link worthless as a founder signal: sponsorship
 * marketplaces, promo networks, link aggregators and social profiles. Three
 * accounts in one day's harvest shared the same hyperagent.com referral link —
 * that's a promo network, not a product.
 */
export const X_SITE_DENYLIST = [
  "passionfroot.me",
  "hyperagent.com",
  "linktr.ee",
  "beacons.ai",
  "bio.link",
  "onelink.me",
  "taplink.cc",
  "t.me",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "medium.com",
  "substack.com",
  "gumroad.com",
  "calendly.com",
];

export const X_SCORING = {
  /** Follower count where reach scores highest, and where it starts decaying. */
  reachSweetSpot: [1_000, 100_000] as [number, number],
  reachCeiling: 500_000,
  /**
   * Where the reach curve bottoms out. Deliberately independent of any lane's
   * follower floor, so moving a floor doesn't reshape the curve.
   */
  reachFloor: 150,
  /** following/followers band that reads as a real, reciprocal network. */
  reciprocityBand: [0.2, 3.0] as [number, number],
} as const;

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Tweets per day since the account was created, or null if age is unknown. */
export function tweetsPerDay(u: XUser, now: Date): number | null {
  if (!u.createdAt) return null;
  const days = (now.getTime() - Date.parse(u.createdAt)) / 86_400_000;
  if (!Number.isFinite(days) || days < 1) return null;
  return u.tweetCount / days;
}

/**
 * Disqualifiers that hold whatever we'd be contacting them about, or null if
 * they survive. Lane fit is a separate question — see `lanesFor`. Deliberately
 * no follower floor here: the lanes own their floors.
 */
export function dropReason(u: XUser, ctx: XDropContext, now: Date = new Date()): string | null {
  const handle = u.username.toLowerCase();

  if (ctx.seeds.has(handle)) return "seed account";
  if (ctx.blocked.has(handle)) return "one of our own accounts";
  if (u.protected) return "protected account";
  if (u.automated) return "flagged automated by the provider";
  if (!u.description) return "no bio";
  if (X_DROPS.bioSpam.test(u.description)) return "follow-farm bio";

  const ratio = u.followers > 0 ? u.following / u.followers : Infinity;
  if (ratio > X_DROPS.maxFollowRatio) return `follows ${ratio.toFixed(1)}x more than follow back`;

  const perDay = tweetsPerDay(u, now);
  if (perDay !== null && perDay > X_DROPS.maxTweetsPerDay) {
    return `${Math.round(perDay)} tweets/day — automated`;
  }
  return null;
}

/**
 * Bio keyword hits for a lane. Each keyword is a stem: it matches with an
 * optional s/es/ing/er/ers/ed tail, so "agent" catches "agents" and "build"
 * catches "building", while "ai" still doesn't catch "airplane".
 */
export function topicHits(bio: string, lane: XLane): string[] {
  const lower = bio.toLowerCase();
  return X_LANES[lane].keywords.filter((k) => {
    const stem = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z])${stem}(s|es|ing|er|ers|ed)?([^a-z]|$)`, "i").test(lower);
  });
}

/** A GitHub profile anywhere on the profile. The best free proof of a dev. */
export function hasGithub(u: XUser): boolean {
  return (u.links ?? []).some((l) => /(^|\/\/|\.)github\.(com|io)\b/i.test(l));
}

/** Whether a bio link points at something they built, or at a promo page. */
export function siteIsOwnWork(site: string | undefined): boolean {
  if (!site) return false;
  const host = site
    .replace(/^https?:\/\//, "")
    .split("/")[0]!
    .toLowerCase()
    .replace(/^www\./, "");
  return !X_SITE_DENYLIST.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/** Which lanes this person qualifies for. Empty means don't contact them. */
export function lanesFor(u: XUser): XLane[] {
  const out: XLane[] = [];
  for (const lane of ["founder", "amplifier"] as XLane[]) {
    const cfg = X_LANES[lane];
    if (u.followers < cfg.minFollowers) continue;
    if (cfg.requiresSite && !siteIsOwnWork(u.site)) continue;
    // A GitHub link clears the topic gate on its own; otherwise the bio has to.
    const cleared =
      (cfg.requiresDevSignal && hasGithub(u)) ||
      topicHits(u.description, lane).length >= cfg.minTopicHits;
    if (!cleared) continue;
    out.push(lane);
  }
  return out;
}

/** Reach: peaks inside the sweet spot, decays hard above it. */
export function reachScore(followers: number): number {
  const [lo, hi] = X_SCORING.reachSweetSpot;
  const floor = X_SCORING.reachFloor;
  if (followers <= lo) {
    const span = Math.log10(lo) - Math.log10(floor);
    return 0.4 + 0.6 * clamp((Math.log10(followers) - Math.log10(floor)) / span);
  }
  if (followers <= hi) return 1;
  const span = Math.log10(X_SCORING.reachCeiling) - Math.log10(hi);
  const past = (Math.log10(followers) - Math.log10(hi)) / span;
  return clamp(1 - 0.85 * past, 0.1, 1);
}

/** A reciprocal follow graph reads as a person, not a billboard. */
export function reciprocityScore(u: XUser): number {
  const [lo, hi] = X_SCORING.reciprocityBand;
  const ratio = u.followers > 0 ? u.following / u.followers : 0;
  if (ratio >= lo && ratio <= hi) return 1;
  if (ratio < lo) return clamp(0.3 + 0.7 * (ratio / lo), 0.3, 1);
  return clamp(1 - (ratio - hi) / (X_DROPS.maxFollowRatio - hi), 0, 1);
}

/**
 * The strongest amplifier signal: they repost this kind of thing, repeatedly.
 * `prior` is a hook for a future "seen N times before" boost — the pack fed it
 * from its roster; here queue dedupe means a candidate is only enqueued once,
 * so v1 passes nothing.
 */
export function habitScore(c: XCandidate, prior?: { timesSeen: number }): number {
  const distinctSeeds = new Set(c.hits.map((h) => h.seed)).size;
  const repeat = Math.min(prior?.timesSeen ?? 0, 4);
  const quoted = c.modes.includes("quote") ? 1 : 0;
  const raw = c.hits.length + 1.5 * (distinctSeeds - 1) + 0.75 * repeat + quoted;
  return clamp(raw / 5);
}

export function scoreCandidate(
  c: XCandidate,
  lanes: XLane[],
  prior?: { timesSeen: number },
): XScoredCandidate {
  const u = c.user;
  // Founder wins when someone qualifies for both: a person who could run the
  // thing is worth more than one more repost.
  const lane: XLane = lanes.includes("founder") ? "founder" : "amplifier";
  const w = X_LANES[lane].weights;

  const hits = topicHits(u.description, lane);
  // A GitHub link is worth more than any two bio words.
  const topic = clamp((hits.length + (hasGithub(u) ? 2 : 0)) / 4);
  const score = Math.round(
    100 *
      (w.reach * reachScore(u.followers) +
        w.reciprocity * reciprocityScore(u) +
        w.habit * habitScore(c, prior) +
        w.topic * topic),
  );

  const seeds = [...new Set(c.hits.map((h) => h.seed))];
  const parts = [
    `${formatCount(u.followers)} followers`,
    `${c.modes.includes("quote") ? "quoted" : "reposted"} ${c.hits.length} of @${seeds.join(", @")}`,
  ];
  if (hasGithub(u)) parts.push("github in bio");
  if (lane === "founder" && u.site) parts.push(u.site.replace(/^https?:\/\//, ""));
  if (hits.length) parts.push(`bio: ${hits.slice(0, 4).join(", ")}`);
  if (lanes.length > 1) parts.push("also an amplifier");
  if (prior?.timesSeen) parts.push(`seen ${prior.timesSeen}x before`);

  return { candidate: c, lane, lanes, score, why: parts.join(" · ") };
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
