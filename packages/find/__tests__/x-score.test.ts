import { describe, expect, test } from "vitest";
import {
  dropReason,
  habitScore,
  lanesFor,
  reachScore,
  reciprocityScore,
  scoreCandidate,
  topicHits,
} from "../src/_x-score.ts";
import type { XCandidate, XHit, XUser } from "../src/_x-types.ts";

const NOW = new Date("2026-08-27T09:00:00Z");

function user(over: Partial<XUser> = {}): XUser {
  return {
    id: "1",
    username: "someone",
    name: "Some One",
    description: "building AI agents, shipping in public",
    followers: 8_000,
    following: 900,
    tweetCount: 4_000,
    dmOpen: true,
    links: [],
    createdAt: "2021-01-01T00:00:00Z",
    ...over,
  };
}

function tweet(over: Partial<XHit> = {}): XHit {
  return {
    id: "t1",
    seed: "iamdevloper",
    mode: "retweet",
    text: "a joke about printers",
    url: "https://x.com/iamdevloper/status/t1",
    createdAt: NOW.toISOString(),
    retweets: 30,
    ...over,
  };
}

function candidate(over: Partial<XCandidate> = {}): XCandidate {
  return { user: user(), hits: [tweet()], modes: ["retweet"], ...over };
}

const ctx = { seeds: new Set(["iamdevloper"]), blocked: new Set(["nclsjrry"]) };

describe("dropReason", () => {
  test("keeps a plausible amplifier", () => {
    expect(dropReason(user(), ctx, NOW)).toBeNull();
  });

  test("drops the seed accounts themselves", () => {
    expect(dropReason(user({ username: "IamDevloper" }), ctx, NOW)).toBe("seed account");
  });

  test("drops our own handles", () => {
    expect(dropReason(user({ username: "nclsjrry" }), ctx, NOW)).toMatch(/our own/);
  });

  test("drops empty bios", () => {
    expect(dropReason(user({ description: "" }), ctx, NOW)).toBe("no bio");
  });

  test("drops follow-farm bios", () => {
    expect(dropReason(user({ description: "follow back 100% 🔥 F4F" }), ctx, NOW)).toBe(
      "follow-farm bio",
    );
  });

  test("drops accounts that follow far more than follow them back", () => {
    expect(dropReason(user({ followers: 6_000, following: 60_000 }), ctx, NOW)).toMatch(
      /more than follow back/,
    );
  });

  test("leaves the follower floor to the lane, not the shared drops", () => {
    // 40 followers survives the shared drops; the lane decides whether to keep it.
    expect(dropReason(user({ followers: 40, following: 20 }), ctx, NOW)).toBeNull();
  });

  test("drops automated posting volume", () => {
    // ~2000 days old, 900k tweets => 450/day
    expect(dropReason(user({ tweetCount: 900_000 }), ctx, NOW)).toMatch(/tweets\/day/);
  });

  test("drops provider-flagged bots and protected accounts", () => {
    expect(dropReason(user({ automated: true }), ctx, NOW)).toMatch(/automated/);
    expect(dropReason(user({ protected: true }), ctx, NOW)).toBe("protected account");
  });

  test("tolerates an unknown account age", () => {
    expect(dropReason(user({ createdAt: undefined, tweetCount: 900_000 }), ctx, NOW)).toBeNull();
  });
});

describe("reachScore", () => {
  test("peaks inside the sweet spot", () => {
    expect(reachScore(10_000)).toBe(1);
    expect(reachScore(1_000)).toBeCloseTo(1, 1);
  });

  test("penalises the megaphones", () => {
    expect(reachScore(2_000_000)).toBeLessThan(reachScore(50_000));
    expect(reachScore(400_000)).toBeLessThan(reachScore(50_000));
  });

  test("penalises the very small", () => {
    expect(reachScore(200)).toBeLessThan(reachScore(5_000));
  });
});

describe("reciprocityScore", () => {
  test("rewards a two-way follow graph", () => {
    expect(reciprocityScore(user({ followers: 5_000, following: 2_000 }))).toBe(1);
  });

  test("marks down a pure broadcast tower", () => {
    expect(reciprocityScore(user({ followers: 400_000, following: 0 }))).toBeLessThan(0.5);
  });

  test("marks down a near-farm", () => {
    expect(reciprocityScore(user({ followers: 1_000, following: 7_000 }))).toBeLessThan(0.5);
  });
});

describe("habitScore", () => {
  test("two seeds beat two tweets from one seed", () => {
    const oneSeed = candidate({ hits: [tweet({ id: "a" }), tweet({ id: "b" })] });
    const twoSeeds = candidate({
      hits: [tweet({ id: "a" }), tweet({ id: "b", seed: "ElaraGrace_AI" })],
    });
    expect(habitScore(twoSeeds)).toBeGreaterThan(habitScore(oneSeed));
  });

  test("prior sightings compound (future ledger-backed hook)", () => {
    expect(habitScore(candidate(), { timesSeen: 4 })).toBeGreaterThan(habitScore(candidate()));
  });

  test("a quote counts for more than a bare repost", () => {
    expect(habitScore(candidate({ modes: ["retweet", "quote"] }))).toBeGreaterThan(
      habitScore(candidate()),
    );
  });
});

describe("topicHits", () => {
  test("matches stems, not substrings", () => {
    expect(topicHits("building AI agents", "amplifier")).toEqual(
      expect.arrayContaining(["ai", "agent", "build"]),
    );
    expect(topicHits("chairman of the bored", "amplifier")).not.toContain("ai");
  });

  test("each lane reads the bio through its own vocabulary", () => {
    const bio = "co-founder, bootstrapped, shipping a dev tool";
    expect(topicHits(bio, "founder")).toEqual(
      expect.arrayContaining(["founder", "bootstrapped", "shipping"]),
    );
    expect(topicHits(bio, "amplifier").length).toBeLessThan(topicHits(bio, "founder").length);
  });
});

describe("lanesFor", () => {
  const amp = user({ followers: 20_000, description: "backend engineer, mostly rust" });
  const founder = user({
    followers: 800,
    description: "co-founder, building an open source agent runtime",
    site: "https://example.com",
  });

  test("a dev account is an amplifier", () => {
    expect(lanesFor(amp)).toEqual(["amplifier"]);
  });

  test("an AI-tips account with no dev signal is not", () => {
    expect(lanesFor(user({ followers: 30_000, description: "AI tools & prompts daily" }))).toEqual(
      [],
    );
  });

  test("a github link clears the gate on its own", () => {
    const u = user({
      followers: 1_200,
      description: "just vibes",
      links: ["https://github.com/someone"],
    });
    expect(lanesFor(u)).toEqual(["amplifier"]);
  });

  test("a small founder with a site qualifies where an amplifier would not", () => {
    expect(lanesFor(founder)).toEqual(["founder"]);
  });

  test("the founder lane needs a link in the bio", () => {
    expect(lanesFor({ ...founder, site: undefined })).toEqual([]);
  });

  test("a sponsorship or link-aggregator page is not a founder signal", () => {
    for (const site of [
      "https://www.passionfroot.me/someone",
      "https://hyperagent.com/s/cPjeDjvSIzVOtiAnRGXEig",
      "http://t.me/promo",
      "https://linktr.ee/someone",
      "http://www.linkedin.com/in/someone",
    ]) {
      expect(lanesFor({ ...founder, site })).toEqual([]);
    }
    expect(lanesFor({ ...founder, site: "https://melizeche.com" })).toEqual(["founder"]);
  });

  test("one claimed word is not a founder", () => {
    expect(lanesFor({ ...founder, description: "founder", site: "https://example.com" })).toEqual(
      [],
    );
  });

  test("someone can be both, and founder is listed first", () => {
    const both = user({
      followers: 30_000,
      description: "founder, building AI dev tools, shipping in public",
      site: "https://example.com",
    });
    expect(lanesFor(both)).toEqual(["founder", "amplifier"]);
  });

  test("an off-topic account fits neither lane", () => {
    expect(lanesFor(user({ followers: 50_000, description: "cat pictures and coffee" }))).toEqual(
      [],
    );
    expect(
      lanesFor(
        user({ followers: 50_000, description: "cat pictures", links: ["https://linktr.ee/x"] }),
      ),
    ).toEqual([]);
  });
});

describe("scoreCandidate", () => {
  test("a mid-size on-topic double-seed reposter outranks a huge off-topic one", () => {
    const good = scoreCandidate(
      candidate({ hits: [tweet(), tweet({ id: "b", seed: "ElaraGrace_AI" })] }),
      ["amplifier"],
    );
    const meh = scoreCandidate(
      candidate({
        user: user({ followers: 3_000_000, following: 12, description: "cat pictures" }),
      }),
      ["amplifier"],
    );
    expect(good.score).toBeGreaterThan(meh.score);
    expect(good.score).toBeLessThanOrEqual(100);
    expect(meh.score).toBeGreaterThanOrEqual(0);
  });

  test("founder wins when someone qualifies for both", () => {
    const sc = scoreCandidate(candidate(), ["founder", "amplifier"]);
    expect(sc.lane).toBe("founder");
    expect(sc.why).toContain("also an amplifier");
  });

  test("reach barely moves a founder score, and dominates an amplifier one", () => {
    // Same follow ratio on both, so only reach differs between them.
    const small = user({
      followers: 600,
      following: 300,
      description: "founder building an agent",
      site: "https://a.co",
    });
    const big = user({
      followers: 60_000,
      following: 30_000,
      description: "founder building an agent",
      site: "https://a.co",
    });
    const fSpread =
      scoreCandidate(candidate({ user: big }), ["founder"]).score -
      scoreCandidate(candidate({ user: small }), ["founder"]).score;
    const aSpread =
      scoreCandidate(candidate({ user: big }), ["amplifier"]).score -
      scoreCandidate(candidate({ user: small }), ["amplifier"]).score;
    expect(fSpread).toBeGreaterThanOrEqual(0);
    expect(fSpread).toBeLessThan(aSpread);
  });

  test("a founder's site shows up in the why line", () => {
    const u = user({ description: "founder building an agent", site: "https://melizeche.com" });
    expect(scoreCandidate(candidate({ user: u }), ["founder"]).why).toContain("melizeche.com");
  });

  test("the why line names the seeds and the follower count", () => {
    const { why } = scoreCandidate(candidate(), ["amplifier"]);
    expect(why).toContain("8.0k followers");
    expect(why).toContain("@iamdevloper");
  });
});
