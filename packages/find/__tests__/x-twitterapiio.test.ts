import { describe, expect, test } from "vitest";
import { CostMeter } from "../src/_x-cost.ts";
import { BudgetExhausted, DEFAULT_KNOBS } from "../src/_x-engine.ts";
import { TwitterApiIoEngine, mapTwitterApiIoUser } from "../src/_x-twitterapiio.ts";

const KNOBS = { ...DEFAULT_KNOBS.twitterapiio };

/** A retweeters row, shaped like the documented response. */
function row(over: Record<string, unknown> = {}) {
  return {
    type: "user",
    id: "42",
    userName: "someone",
    name: "Some One",
    description: "building an agent runtime",
    location: "SF",
    isBlueVerified: true,
    followers: 8000,
    following: 900,
    statusesCount: 4000,
    canDm: true,
    isAutomated: false,
    createdAt: "2021-01-01T00:00:00Z",
    profile_bio: {
      description: "building an agent runtime",
      entities: {
        url: { urls: [{ expanded_url: "https://example.com" }] },
        description: { urls: [{ expanded_url: "https://github.com/someone" }] },
      },
    },
    ...over,
  };
}

function fake(pages: unknown[]) {
  let i = 0;
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const body = pages[Math.min(i++, pages.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const engine = (impl: typeof fetch, ceiling = Infinity) =>
  new TwitterApiIoEngine({
    apiKey: "k",
    fetch: impl,
    meter: new CostMeter("twitterapiio", ceiling),
    knobs: KNOBS,
  });

describe("mapTwitterApiIoUser", () => {
  test("maps every field the scoring depends on", () => {
    const u = mapTwitterApiIoUser(row());
    expect(u.username).toBe("someone");
    expect(u.followers).toBe(8000);
    expect(u.following).toBe(900);
    expect(u.tweetCount).toBe(4000); // statusesCount
    expect(u.dmOpen).toBe(true); // canDm
    expect(u.verified).toBe(true); // isBlueVerified
    expect(u.automated).toBe(false);
    expect(u.createdAt).toBe("2021-01-01T00:00:00Z");
  });

  test("collects links from the website field and the bio text", () => {
    const u = mapTwitterApiIoUser(row());
    expect(u.links).toEqual(["https://example.com", "https://github.com/someone"]);
    expect(u.site).toBe("https://example.com");
  });

  test("survives a sparse row without throwing", () => {
    const u = mapTwitterApiIoUser({ id: "1", userName: "x" });
    expect(u.followers).toBe(0);
    expect(u.links).toEqual([]);
    expect(u.dmOpen).toBe(false);
  });
});

describe("retweetedBy", () => {
  test("follows cursor pages and charges per user returned", async () => {
    const { impl, calls } = fake([
      {
        users: [row({ userName: "a" }), row({ userName: "b" })],
        has_next_page: true,
        next_cursor: "c1",
      },
      { users: [row({ userName: "c" })], has_next_page: false },
    ]);
    const e = engine(impl);
    const users = await e.retweetedBy("t1");
    expect(users.map((u) => u.username)).toEqual(["a", "b", "c"]);
    expect(e.meter.users).toBe(3);
    expect(calls[1]).toContain("cursor=c1");
  });

  test("stops at the last page rather than looping", async () => {
    const { impl, calls } = fake([{ users: [row()], has_next_page: false }]);
    await engine(impl).retweetedBy("t1");
    expect(calls).toHaveLength(1);
  });

  test("refuses the next page when it would break the ceiling", async () => {
    const { impl } = fake([{ users: [row()], has_next_page: true, next_cursor: "c" }]);
    // Ceiling below one page of users.
    await expect(engine(impl, 0.000001).retweetedBy("t1")).rejects.toBeInstanceOf(BudgetExhausted);
  });

  test("out of credits stops the run instead of crashing it", async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({ error: "Unauthorized", message: "Credits is not enough.Please recharge" }),
        { status: 401 },
      )) as unknown as typeof fetch;
    await expect(engine(impl).retweetedBy("t1")).rejects.toBeInstanceOf(BudgetExhausted);
  });
});

describe("quoteTweets", () => {
  test("returns the quoting authors and charges for posts and users", async () => {
    const { impl } = fake([
      { tweets: [{ id: "q1", author: row({ userName: "quoter" }) }], has_next_page: false },
    ]);
    const e = engine(impl);
    const users = await e.quoteTweets("t1");
    expect(users.map((u) => u.username)).toEqual(["quoter"]);
    expect(e.meter.users).toBe(1);
    expect(e.meter.posts).toBe(1);
  });
});

describe("recentTweets", () => {
  test("drops replies and applies the freshness and repost filters", async () => {
    const fresh = new Date(Date.now() - 3600_000).toISOString();
    const { impl } = fake([
      {
        data: {
          tweets: [
            { id: "a", text: "reply", createdAt: fresh, retweetCount: 50, isReply: true },
            { id: "b", text: "quiet", createdAt: fresh, retweetCount: 1 },
            { id: "c", text: "good", createdAt: fresh, retweetCount: 40 },
            { id: "d", text: "old", createdAt: "2020-01-01T00:00:00Z", retweetCount: 90 },
          ],
        },
      },
    ]);
    const tweets = await engine(impl).recentTweets("1", "someseed");
    expect(tweets.map((t) => t.id)).toEqual(["c"]);
    expect(tweets[0]!.url).toBe("https://x.com/someseed/status/c");
  });
});

describe("enrich", () => {
  test("fills links/site/bot-flag on the reduced rows it was given, in place", async () => {
    // Reduced rows as `retweeters` returns them: no entities, no isAutomated.
    const reduced = [
      mapTwitterApiIoUser({
        id: "1",
        userName: "a",
        description: "building agents",
        followers: 900,
      }),
      mapTwitterApiIoUser({ id: "2", userName: "b", description: "shipping", followers: 500 }),
    ];
    const { impl, calls } = fake([
      {
        users: [
          row({ id: "1", userName: "a", isAutomated: true }),
          row({ id: "2", userName: "b" }),
        ],
      },
    ]);
    const e = engine(impl);
    await e.enrich(reduced);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("batch_info_by_ids");
    expect(reduced[0]!.automated).toBe(true);
    expect(reduced[1]!.links).toEqual(["https://example.com", "https://github.com/someone"]);
    expect(reduced[1]!.site).toBe("https://example.com");
    // Reduced row's own description survives when the full row has one too.
    expect(reduced[0]!.description.length).toBeGreaterThan(0);
    expect(e.meter.users).toBe(2);
  });

  test("silently skips ids the API did not return", async () => {
    const reduced = [mapTwitterApiIoUser({ id: "9", userName: "ghost" })];
    const { impl } = fake([{ users: [] }]);
    await expect(engine(impl).enrich(reduced)).resolves.toBeUndefined();
    expect(reduced[0]!.links).toEqual([]);
  });
});
