import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// standardEnrich's research step waits out a OneShot 429 instead of turning
// the row into an error draft: the drain's parallel rows and a scheduler
// sweep share one wallet's rate limit (2026-10-05: ten accelerator-batch rows
// all errored on `rate_limit_exceeded`, `retry_after: 60`).

/** A ToolError as the SDK throws it for a 429. */
function rateLimited(): Error {
  return Object.assign(new Error("Tool request failed"), {
    statusCode: 429,
    responseBody: JSON.stringify({
      error: "rate_limit_exceeded",
      message: "Too many requests, please try again later.",
      retry_after: 60,
    }),
  });
}

let researchOutcomes: Array<Error | "ok"> = [];
let researchCalls = 0;
const events: Array<{ kind: string; ctx: Record<string, unknown> }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    enrichProfile: async () => ({
      result: { status: "completed", profile: { full_name: "Pat" }, cost: 0.005 },
      receiptId: 7,
    }),
    deepResearch: async () => {
      researchCalls++;
      const next = researchOutcomes.shift() ?? "ok";
      if (next !== "ok") throw next;
      return { result: { report: "Pat shipped a launch" }, receiptId: 9 };
    },
    logEvent: (kind: string, ctx: Record<string, unknown>) => void events.push({ kind, ctx }),
    getLedger: () => ({
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      setCachedEnrichmentFailure: () => {},
    }),
  };
});

const { standardEnrich, _setResearchSleep } = await import("../src/_run-play.ts");
const { rateLimitRetryAfterS } = await import("@oneshot-gtm/core");

const sleeps: number[] = [];
const run = (signal?: AbortSignal) =>
  standardEnrich({
    playName: "accelerator-batch",
    enrichInput: { email: "pat@x.dev" },
    enrichSlice: 3500,
    research: { topic: "Pat at X" },
    ...(signal ? { signal } : {}),
  });

beforeEach(() => {
  researchOutcomes = [];
  researchCalls = 0;
  events.length = 0;
  sleeps.length = 0;
  _setResearchSleep(async (ms) => void sleeps.push(ms));
});
afterEach(() => vi.clearAllMocks());

describe("rateLimitRetryAfterS", () => {
  it("reads retry_after from a 429 body and ignores other errors", () => {
    expect(rateLimitRetryAfterS(rateLimited())).toBe(60);
    expect(rateLimitRetryAfterS(new Error("Tool request failed"))).toBeNull();
    expect(rateLimitRetryAfterS(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(60);
  });
});

describe("standardEnrich research under a rate limit", () => {
  it("waits out retry_after and drafts from the research", async () => {
    researchOutcomes = [rateLimited()];
    const prep = await run();
    expect(researchCalls).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
    expect(sleeps[0]).toBeLessThan(65_000);
    expect(prep.dossier).toContain("Pat shipped a launch");
    expect(prep.receiptIds).toEqual([7, 9]);
    expect(events.find((e) => e.kind === "research.rate_limited")?.ctx).toMatchObject({
      play: "accelerator-batch",
      retry_after_s: 60,
      attempt: 0,
    });
  });

  it("gives up after two retries, so the row still errors rather than waiting forever", async () => {
    researchOutcomes = [rateLimited(), rateLimited(), rateLimited()];
    await expect(run()).rejects.toThrow("Tool request failed");
    expect(researchCalls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("never retries an error that is not a rate limit", async () => {
    researchOutcomes = [new Error("Tool execution failed")];
    await expect(run()).rejects.toThrow("Tool execution failed");
    expect(researchCalls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("a run cancelled during the wait stops instead of retrying", async () => {
    const ctl = new AbortController();
    _setResearchSleep(async () => void ctl.abort());
    researchOutcomes = [rateLimited()];
    await expect(run(ctl.signal)).rejects.toThrow();
    expect(researchCalls).toBe(1);
  });
});
