import { describe, expect, test } from "vitest";
import { CostMeter } from "../src/_x-cost.ts";
import { BudgetExhausted, DEFAULT_KNOBS } from "../src/_x-engine.ts";
import { XApiEngine } from "../src/_x-api.ts";

const CREDS = { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "ats" };

function userJson(username: string, over: Record<string, unknown> = {}) {
  return {
    id: `u-${username}`,
    username,
    name: username,
    description: "building AI agents",
    created_at: "2021-01-01T00:00:00Z",
    receives_your_dm: true,
    entities: {
      url: { urls: [{ expanded_url: "https://example.com" }] },
      description: { urls: [{ expanded_url: "https://github.com/someone" }] },
    },
    public_metrics: { followers_count: 8_000, following_count: 900, tweet_count: 4_000 },
    ...over,
  };
}

function fakeFetch(
  body: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: opts.headers ?? { "x-rate-limit-remaining": "70" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const engine = (impl: typeof fetch, knobs = DEFAULT_KNOBS.xapi) =>
  new XApiEngine({ creds: CREDS, fetch: impl, meter: new CostMeter("xapi", Infinity), knobs });

describe("XApiEngine", () => {
  test("asks for receives_your_dm + entities on the lookup calls and maps them", async () => {
    const { impl, calls } = fakeFetch({ data: [userJson("alice")] });
    const users = await engine(impl).retweetedBy("t1");
    expect(calls[0]).toContain("receives_your_dm");
    expect(calls[0]).toContain("entities");
    expect(users[0]!.dmOpen).toBe(true);
    expect(users[0]!.links).toEqual(["https://example.com", "https://github.com/someone"]);
    expect(users[0]!.site).toBe("https://example.com");
  });

  test("a 429 surfaces as BudgetExhausted, not a retry storm", async () => {
    const { impl, calls } = fakeFetch({ data: [] }, { status: 429 });
    await expect(engine(impl).retweetedBy("t1")).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toHaveLength(1);
  });

  test("a 402 (monthly quota) is a stop, and says so", async () => {
    const { impl } = fakeFetch({ data: [] }, { status: 402 });
    await expect(engine(impl).quoteTweets("t1")).rejects.toThrow(/credits depleted/);
  });

  test("refuses the next lookup once x-rate-limit-remaining is exhausted", async () => {
    const { impl, calls } = fakeFetch(
      { data: [userJson("alice")] },
      { headers: { "x-rate-limit-remaining": "1" } },
    );
    const e = engine(impl);
    await e.retweetedBy("t1"); // succeeds, records remaining=1
    await expect(e.retweetedBy("t2")).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toHaveLength(1);
  });

  test("stops at the lookup-call cap so a manual re-run still fits the window", async () => {
    const { impl } = fakeFetch({ data: [] });
    const e = engine(impl, { ...DEFAULT_KNOBS.xapi, maxLookupCalls: 2 });
    await e.retweetedBy("t1");
    await e.quoteTweets("t1");
    await expect(e.retweetedBy("t2")).rejects.toThrow(/lookup cap/);
  });

  test("clamps max_results to X's 100 cap", async () => {
    const { impl, calls } = fakeFetch({ data: [] });
    await engine(impl, { ...DEFAULT_KNOBS.xapi, maxPerTweet: 500 }).retweetedBy("t1");
    expect(calls[0]).toContain("max_results=100");
  });

  test("any other non-ok status is a hard error, not a silent empty", async () => {
    const { impl } = fakeFetch({ error: "boom" }, { status: 500 });
    await expect(engine(impl).retweetedBy("t1")).rejects.toThrow(/failed \(500\)/);
  });
});
