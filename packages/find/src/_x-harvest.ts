/** Seed accounts → merged candidates. The only part that talks to X. */

import { SpendExceeded } from "./_x-cost.ts";
import { BudgetExhausted, type HarvestEngine, type HarvestKnobs } from "./_x-engine.ts";
import type { SeedTweet, XCandidate, XHit, XSeed, XUser } from "./_x-types.ts";

export interface XHarvestResult {
  candidates: XCandidate[];
  tweetsScanned: number;
  /** Set when the run stopped early on a rate limit, quota or spend ceiling. */
  stoppedEarly: string | null;
  /** Tweets actually paid for this run, for the skip ledger. */
  harvestedIds: string[];
}

/**
 * For each seed: recent original tweets with real repost counts, then everyone
 * who reposted or quoted them. Reposters are merged across seeds, so someone
 * who boosted two different watched accounts shows up once with both hits.
 */
export async function harvestReposters(
  client: HarvestEngine,
  seeds: XSeed[],
  knobs: HarvestKnobs,
  log: (msg: string) => void = () => {},
  /** Tweet ids already paid for recently — skipped, never re-fetched. */
  skipTweets: Set<string> = new Set(),
): Promise<XHarvestResult> {
  const byHandle = new Map<string, XCandidate>();
  const harvestedIds: string[] = [];
  let tweetsScanned = 0;
  let skipped = 0;
  let stoppedEarly: string | null = null;

  // A spend ceiling and a rate limit both mean "stop, keep what you have".
  const isStop = (e: unknown) => e instanceof BudgetExhausted || e instanceof SpendExceeded;

  const add = (u: XUser, tweet: SeedTweet, mode: "retweet" | "quote") => {
    // Per-hit mode (and quote text) so downstream grounding can pair the mode
    // with the tweet it actually applies to — the merged `modes` list alone
    // can't say WHICH tweet was quoted.
    const hit: XHit = {
      ...tweet,
      mode,
      ...(mode === "quote" && u.quoteText ? { quoteText: u.quoteText } : {}),
    };
    const key = u.username.toLowerCase();
    const existing = byHandle.get(key);
    if (!existing) {
      byHandle.set(key, { user: u, hits: [hit], modes: [mode] });
      return;
    }
    const prior = existing.hits.find((h) => h.id === tweet.id);
    if (!prior) {
      existing.hits.push(hit);
    } else if (mode === "quote" && prior.mode !== "quote") {
      // Same tweet both plain-reposted and quoted — the quote is the stronger hit.
      prior.mode = "quote";
      if (u.quoteText) prior.quoteText = u.quoteText;
    }
    if (!existing.modes.includes(mode)) existing.modes.push(mode);
  };

  outer: for (const seed of seeds) {
    let user, tweets;
    try {
      user = await client.resolveUser(seed.handle);
      if (!user) {
        log(`  @${seed.handle}: not found, skipping`);
        continue;
      }
      tweets = await client.recentTweets(user.id, seed.handle);
    } catch (e) {
      if (isStop(e)) {
        stoppedEarly = (e as Error).message;
        log(`  ${stoppedEarly}`);
        break;
      }
      throw e;
    }
    log(
      `  @${seed.handle}: ${tweets.length} tweet(s) in the last ${knobs.sinceHours}h with >=${knobs.minRetweets} reposts`,
    );

    for (const t of tweets) {
      if (skipTweets.has(t.id)) {
        skipped++;
        continue;
      }
      try {
        const reposters = await client.retweetedBy(t.id);
        for (const u of reposters) add(u, t, "retweet");
        // Record the tweet as paid for as soon as the first (retweeted_by)
        // page is bought: if quoteTweets below hits the spend ceiling, the
        // skip ledger must still know this page was purchased, or the next
        // run re-buys it — the exact double-billing the ledger prevents.
        harvestedIds.push(t.id);
        const quoters = await client.quoteTweets(t.id);
        for (const u of quoters) add(u, t, "quote");
        tweetsScanned++;
        log(`    ${t.id}: ${reposters.length} reposters, ${quoters.length} quoters`);
      } catch (e) {
        if (isStop(e)) {
          stoppedEarly = (e as Error).message;
          log(`  ${stoppedEarly}`);
          break outer;
        }
        throw e;
      }
    }
  }

  if (skipped) log(`  skipped ${skipped} tweet(s) already harvested — not paying twice`);
  return { candidates: [...byHandle.values()], tweetsScanned, stoppedEarly, harvestedIds };
}
