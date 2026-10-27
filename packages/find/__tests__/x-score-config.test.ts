import { describe, expect, test } from "vitest";
import { DEFAULT_X_LANE_KEYWORDS, lanesFor, scoreCandidate, topicHits } from "../src/_x-score.ts";
import type { XCandidate, XLane, XUser } from "../src/_x-types.ts";
import { DEV_TOOL_X_LANE_KEYWORDS } from "./fixtures/x-lane-keywords.ts";

function user(i: number, over: Partial<XUser>): XUser {
  return {
    id: String(i),
    username: `u${i}`,
    name: "U",
    description: "",
    followers: 1_000,
    following: 900,
    tweetCount: 4_000,
    dmOpen: true,
    links: [],
    createdAt: "2021-01-01T00:00:00Z",
    ...over,
  };
}

function candidate(u: XUser): XCandidate {
  return {
    user: u,
    hits: [
      {
        id: "t",
        seed: "seedA",
        mode: "retweet",
        text: "x",
        url: "https://x.com/seedA/status/t",
        createdAt: "2026-08-27T09:00:00Z",
        retweets: 3,
      },
    ],
    modes: ["retweet"],
  };
}

const CORPUS: Partial<XUser>[] = [
  { description: "backend engineer, mostly rust", followers: 20000 },
  { description: "AI tools & prompts daily", followers: 30000 },
  { description: "just vibes", followers: 1200, links: ["https://github.com/someone"] },
  {
    description: "co-founder, building an open source agent runtime",
    followers: 800,
    site: "https://example.com",
  },
  { description: "founder", followers: 800, site: "https://example.com" },
  {
    description: "founder, building AI dev tools, shipping in public",
    followers: 30000,
    site: "https://example.com",
  },
  { description: "cat pictures and coffee", followers: 50000 },
  {
    description: "founder building an agent",
    followers: 600,
    following: 300,
    site: "https://a.co",
  },
  {
    description: "founder building an agent",
    followers: 60000,
    following: 30000,
    site: "https://a.co",
    links: ["https://github.com/x"],
  },
  { description: "ceo of a bootstrapped saas, yc w24", followers: 4000, site: "https://b.example" },
  {
    description: "typescript and react developer, open source maintainer",
    followers: 150000,
    following: 200,
  },
  { description: "indie hacker shipping llm apps", followers: 2500, site: "https://linktr.ee/x" },
  { description: "dental practice owner", followers: 3000, site: "https://smile.example" },
  {
    description: "cto, devops and infra, golang",
    followers: 900,
    site: "https://c.example",
    links: ["https://github.com/c"],
  },
  { description: "building agents. coding daily.", followers: 1000 },
  { description: "solo founder", followers: 299, site: "https://d.example" },
];

/**
 * What the built-in lane lists produced for CORPUS before they moved to
 * config: [lanes, [founder score, why], [amplifier score, why]], recorded
 * from the code as it was.
 */
const BEFORE: Array<[XLane[], [number, string], [number, string]]> = [
  [
    ["amplifier"],
    [16, "20k followers · reposted 1 of @seedA"],
    [62, "20k followers · reposted 1 of @seedA · bio: engineer, backend, rust"],
  ],
  [
    [],
    [30, "30k followers · reposted 1 of @seedA · bio: ai"],
    [41, "30k followers · reposted 1 of @seedA · bio: ai"],
  ],
  [
    ["amplifier"],
    [54, "1.2k followers · reposted 1 of @seedA · github in bio"],
    [60, "1.2k followers · reposted 1 of @seedA · github in bio"],
  ],
  [
    ["founder"],
    [
      84,
      "800 followers · reposted 1 of @seedA · example.com · bio: founder, build, open source, agent",
    ],
    [79, "800 followers · reposted 1 of @seedA · bio: open source, agent, build, founder"],
  ],
  [
    [],
    [39, "800 followers · reposted 1 of @seedA · example.com · bio: founder"],
    [49, "800 followers · reposted 1 of @seedA · bio: founder"],
  ],
  [
    ["founder", "amplifier"],
    [
      75,
      "30k followers · reposted 1 of @seedA · example.com · bio: founder, build, shipping, dev tool",
    ],
    [71, "30k followers · reposted 1 of @seedA · bio: dev, ai, build, founder"],
  ],
  [[], [14, "50k followers · reposted 1 of @seedA"], [30, "50k followers · reposted 1 of @seedA"]],
  [
    ["founder"],
    [68, "600 followers · reposted 1 of @seedA · a.co · bio: founder, build, agent"],
    [67, "600 followers · reposted 1 of @seedA · bio: agent, build, founder"],
  ],
  [
    ["founder", "amplifier"],
    [
      84,
      "60k followers · reposted 1 of @seedA · github in bio · a.co · bio: founder, build, agent",
    ],
    [80, "60k followers · reposted 1 of @seedA · github in bio · bio: agent, build, founder"],
  ],
  [
    ["founder"],
    [84, "4.0k followers · reposted 1 of @seedA · b.example · bio: ceo, bootstrapped, yc, saas"],
    [50, "4.0k followers · reposted 1 of @seedA · bio: saas"],
  ],
  [
    ["amplifier"],
    [27, "150k followers · reposted 1 of @seedA · bio: open source"],
    [65, "150k followers · reposted 1 of @seedA · bio: developer, typescript, react, open source"],
  ],
  [
    ["amplifier"],
    [69, "2.5k followers · reposted 1 of @seedA · linktr.ee/x · bio: shipping, indie, llm"],
    [70, "2.5k followers · reposted 1 of @seedA · bio: llm, hacker, indie"],
  ],
  [
    [],
    [24, "3.0k followers · reposted 1 of @seedA · smile.example"],
    [40, "3.0k followers · reposted 1 of @seedA"],
  ],
  [
    [],
    [69, "900 followers · reposted 1 of @seedA · github in bio · c.example · bio: cto"],
    [79, "900 followers · reposted 1 of @seedA · github in bio · bio: devops, golang, infra"],
  ],
  [
    ["amplifier"],
    [54, "1.0k followers · reposted 1 of @seedA · bio: build, agent"],
    [70, "1.0k followers · reposted 1 of @seedA · bio: agent, build, coding"],
  ],
  [
    [],
    [52, "299 followers · reposted 1 of @seedA · d.example · bio: founder, solo"],
    [42, "299 followers · reposted 1 of @seedA · bio: founder"],
  ],
];

describe("x-reposters lanes from config", () => {
  test("the old built-in lists, supplied as config, score exactly as before", () => {
    expect(CORPUS).toHaveLength(BEFORE.length);
    CORPUS.forEach((over, i) => {
      const u = user(i, over);
      const c = candidate(u);
      const [lanes, founder, amplifier] = BEFORE[i]!;
      expect(lanesFor(u, DEV_TOOL_X_LANE_KEYWORDS), `case ${i}`).toEqual(lanes);
      const f = scoreCandidate(c, ["founder"], DEV_TOOL_X_LANE_KEYWORDS);
      const a = scoreCandidate(c, ["amplifier"], DEV_TOOL_X_LANE_KEYWORDS);
      expect([f.score, f.why], `case ${i} founder`).toEqual(founder);
      expect([a.score, a.why], `case ${i} amplifier`).toEqual(amplifier);
    });
  });

  test("ships with no keywords and no dev-signal shortcut", () => {
    expect(DEFAULT_X_LANE_KEYWORDS).toEqual({
      founderKeywords: [],
      amplifierKeywords: [],
      requiresDevSignal: false,
    });
  });

  test("with no keywords the topic gate is open; follower floors and the site rule still hold", () => {
    const dentist = user(1, {
      description: "dental practice owner",
      followers: 3000,
      site: "https://smile.example",
    });
    expect(lanesFor(dentist)).toEqual(["founder", "amplifier"]);
    expect(lanesFor({ ...dentist, site: undefined })).toEqual(["amplifier"]);
    expect(lanesFor({ ...dentist, followers: 299 })).toEqual([]);
  });

  test("a GitHub link adds nothing unless requiresDevSignal is set", () => {
    const u = user(2, {
      description: "just vibes",
      followers: 1200,
      links: ["https://github.com/x"],
    });
    const plain = scoreCandidate(candidate(u), ["amplifier"]);
    const dev = scoreCandidate(candidate(u), ["amplifier"], {
      ...DEFAULT_X_LANE_KEYWORDS,
      requiresDevSignal: true,
    });
    expect(dev.score).toBeGreaterThan(plain.score);
    // Only amplifier keywords set: the GitHub link clears that gate when allowed.
    const kw = {
      founderKeywords: [],
      amplifierKeywords: ["plumber", "hvac"],
      requiresDevSignal: false,
    };
    expect(lanesFor(u, kw)).toEqual([]);
    expect(lanesFor(u, { ...kw, requiresDevSignal: true })).toEqual(["amplifier"]);
  });

  test("a founder's own vocabulary drives the gate, trimmed and case-folded", () => {
    const kw = {
      founderKeywords: [" Owner ", "Clinic"],
      amplifierKeywords: [],
      requiresDevSignal: false,
    };
    const owner = user(3, {
      description: "owner of two clinics in Austin",
      followers: 500,
      site: "https://clinic.example",
    });
    expect(topicHits(owner.description, "founder", kw)).toEqual(["owner", "clinic"]);
    expect(lanesFor(owner, kw)).toEqual(["founder"]);
    expect(lanesFor({ ...owner, description: "owner, mostly golf" }, kw)).toEqual([]);
    // One keyword can't ask for two hits.
    expect(
      lanesFor({ ...owner, description: "clinic manager" }, { ...kw, founderKeywords: ["clinic"] }),
    ).toEqual(["founder"]);
  });
});
