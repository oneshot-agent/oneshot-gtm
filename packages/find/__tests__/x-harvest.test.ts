import { describe, expect, test } from "vitest";
import { CostMeter } from "../src/_x-cost.ts";
import { BudgetExhausted, DEFAULT_KNOBS } from "../src/_x-engine.ts";
import { XApiEngine } from "../src/_x-api.ts";
import { harvestReposters } from "../src/_x-harvest.ts";

const CREDS = { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "ats" };
const KNOBS = { ...DEFAULT_KNOBS.xapi, tweetsPerSeed: 5, maxPerTweet: 50 };

const fresh = () => new Date(Date.now() - 3600_000).toISOString();

const mkUser = (username: string) => ({
  id: `u-${username}`,
  username,
  name: username,
  description: "building AI agents",
  followers: 8_000,
  following: 900,
  tweetCount: 4_000,
  dmOpen: true,
  links: [],
});

function userJson(username: string, over: Record<string, unknown> = {}) {
  return {
    id: `u-${username}`,
    username,
    name: username,
    description: "building AI agents",
    created_at: "2021-01-01T00:00:00Z",
    receives_your_dm: true,
    entities: { url: { urls: [{ expanded_url: "https://github.com/someone" }] } },
    public_metrics: { followers_count: 8_000, following_count: 900, tweet_count: 4_000 },
    ...over,
  };
}

/** Routes X API paths to canned payloads and counts calls. */
function fakeFetch(
  routes: Record<string, unknown>,
  opts: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const path = new URL(String(url)).pathname.replace("/2", "");
    const key = Object.keys(routes).find((k) => path.includes(k));
    const body = key ? routes[key] : { data: [] };
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: opts.headers ?? { "x-rate-limit-remaining": "70" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const engine = (impl: typeof fetch) =>
  new XApiEngine({
    creds: CREDS,
    fetch: impl,
    meter: new CostMeter("xapi", Infinity),
    knobs: KNOBS,
  });

// Most specific paths first — the fake matches by substring.
const routes = {
  "/retweeted_by": { data: [userJson("alice"), userJson("bob")] },
  "/quote_tweets": {
    data: [{ id: "q1", author_id: "u-alice" }],
    includes: { users: [userJson("alice")] },
  },
  "/users/by/username": {
    data: userJson("iamdevloper", {
      public_metrics: { followers_count: 400_000, following_count: 0, tweet_count: 9_000 },
    }),
  },
  "/tweets": {
    data: [
      { id: "t1", text: "a tweet", created_at: fresh(), public_metrics: { retweet_count: 40 } },
    ],
  },
};

describe("harvestReposters", () => {
  test("merges a reposter across seeds and records both modes", async () => {
    const { impl } = fakeFetch(routes);
    const res = await harvestReposters(
      engine(impl),
      [{ handle: "iamdevloper" }, { handle: "ElaraGrace_AI" }],
      KNOBS,
    );

    const alice = res.candidates.find((c) => c.user.username === "alice")!;
    expect(res.candidates.map((c) => c.user.username).toSorted()).toEqual(["alice", "bob"]);
    // Same tweet id from both seeds in this fixture, so hits dedupe by tweet.
    expect(alice.modes.toSorted()).toEqual(["quote", "retweet"]);
    expect(res.tweetsScanned).toBe(2);
    expect(res.harvestedIds).toEqual(["t1", "t1"]);
  });

  test("skips tweets already in the paid ledger — not paying twice", async () => {
    const { impl, calls } = fakeFetch(routes);
    const res = await harvestReposters(
      engine(impl),
      [{ handle: "iamdevloper" }],
      KNOBS,
      () => {},
      new Set(["t1"]),
    );
    expect(res.candidates).toHaveLength(0);
    expect(res.tweetsScanned).toBe(0);
    expect(res.harvestedIds).toEqual([]);
    expect(calls.some((c) => c.includes("retweeted_by"))).toBe(false);
  });

  test("stops cleanly on the lookup budget instead of burning the window", async () => {
    const { impl } = fakeFetch(routes, { headers: { "x-rate-limit-remaining": "0" } });
    const client = engine(impl);
    const res = await harvestReposters(client, [{ handle: "iamdevloper" }], KNOBS);
    // First retweeted_by succeeds and reports 0 left; quote_tweets is refused.
    expect(res.stoppedEarly).toMatch(/exhausted/);
    expect(client.lookupsUsed).toBeLessThanOrEqual(KNOBS.maxLookupCalls);
  });

  test("a mid-run stop keeps what was harvested and lists only paid tweets", async () => {
    // Hand-rolled engine: tweet t1 harvests fine, t2's reposter call trips the
    // budget. t1's candidates and paid-id survive; t2 leaves no trace.
    const seedTweet = (id: string) => ({
      id,
      seed: "iamdevloper",
      text: "t",
      url: `https://x.com/iamdevloper/status/${id}`,
      createdAt: fresh(),
      retweets: 40,
    });
    const stopEngine = {
      name: "fake",
      meter: new CostMeter("xapi", Infinity),
      resolveUser: async () => mkUser("iamdevloper"),
      recentTweets: async () => [seedTweet("t1"), seedTweet("t2")],
      retweetedBy: async (tweetId: string) => {
        if (tweetId === "t2") throw new BudgetExhausted("spend ceiling hit");
        return [mkUser("alice")];
      },
      quoteTweets: async () => [],
    };
    const res = await harvestReposters(stopEngine, [{ handle: "iamdevloper" }], KNOBS);
    expect(res.stoppedEarly).toMatch(/ceiling/);
    expect(res.candidates.map((c) => c.user.username)).toEqual(["alice"]);
    expect(res.harvestedIds).toEqual(["t1"]);
  });
});

describe("XApiEngine.recentTweets", () => {
  test("keeps only fresh, well-reposted originals, biggest first", async () => {
    const { impl } = fakeFetch({
      "/tweets": {
        data: [
          {
            id: "a",
            text: "old but big",
            created_at: "2020-01-01T00:00:00Z",
            public_metrics: { retweet_count: 500 },
          },
          {
            id: "b",
            text: "fresh, ignored",
            created_at: fresh(),
            public_metrics: { retweet_count: 1 },
          },
          {
            id: "c",
            text: "fresh and good",
            created_at: fresh(),
            public_metrics: { retweet_count: 40 },
          },
          {
            id: "d",
            text: "fresh and better",
            created_at: fresh(),
            public_metrics: { retweet_count: 90 },
          },
        ],
      },
    });
    const tweets = await engine(impl).recentTweets("u1", "iamdevloper");
    expect(tweets.map((t) => t.id)).toEqual(["d", "c"]);
    expect(tweets[0]!.url).toBe("https://x.com/iamdevloper/status/d");
  });
});
