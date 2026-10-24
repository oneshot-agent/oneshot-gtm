import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Failure contract for safeDeepResearchPerson. This call is the most
// expensive and slowest in the toolbox (~$0.05, 2-5 min), so the rules that
// matter are: never re-buy a cached person, never hang forever, and never
// negative-cache a transient error (which would make someone un-researchable
// for the whole failure window after the platform recovers). The caching
// itself is the paid cache's under the wrapper; the mock below runs the real
// one around a fake purchase.

const calls = { deepResearchPerson: 0 };
let behaviour: "ok" | "throw" | "hang" = "ok";
let thrownMessage = "no data for this person";
const logged: string[] = [];

const RESULT = {
  status: "completed",
  result: { enrichment: { firstname: "Pat", lastname: "Lee" } },
  request_id: "req_1",
  cost: 0.05,
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    // A short deadline keeps the "hang" case fast; the production constant is 6 min.
    RESEARCH_DEADLINE_MS: 25,
    deepResearchPerson: (input: unknown, _ctx: unknown, cache?: unknown) =>
      actual.withPaidCache("research.person", input, cache as never, async () => {
        calls.deepResearchPerson++;
        if (behaviour === "throw") throw new Error(thrownMessage);
        if (behaviour === "hang") await new Promise((r) => setTimeout(r, 200));
        return { result: RESULT, receiptId: 9 };
      }),
    logEvent: (name: string) => {
      logged.push(name);
    },
  };
});

const core = await import("@oneshot-gtm/core");
const { safeDeepResearchPerson, hasCachedResearch } = await import("../src/_sdk-safe.ts");

const CTX = { playName: "test-play" };
const PAT = { socialMediaUrl: "https://github.com/pat" };

function stored(input: unknown) {
  return core.readPaidCache("research.person", input);
}

function seed(input: unknown, status: "ok" | "failed", ageMs = 0, resultJson?: string): void {
  core.getSharedDb().setPaidCache({
    key: core.paidCacheKey("research.person", input),
    callType: "research.person",
    status,
    resultJson:
      resultJson ?? (status === "ok" ? JSON.stringify(RESULT) : JSON.stringify({ message: "x" })),
    costUsd: status === "ok" ? 0.05 : null,
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

beforeEach(() => {
  calls.deepResearchPerson = 0;
  behaviour = "ok";
  thrownMessage = "no data for this person";
  logged.length = 0;
  core._resetPaidCache();
});

afterEach(() => vi.clearAllMocks());

describe("safeDeepResearchPerson", () => {
  it("stores a successful research for the person", async () => {
    const out = await safeDeepResearchPerson(PAT, CTX);
    expect(out.receiptId).toBe(9);
    expect(calls.deepResearchPerson).toBe(1);
    expect(stored(PAT)?.status).toBe("ok");
    // The URL names the person whatever else the input carries.
    expect(hasCachedResearch({ socialMediaUrl: "https://GitHub.com/Pat", name: "Pat" })).toBe(true);
  });

  it("serves a fresh cache hit for free — no SDK call, receiptId 0", async () => {
    seed(PAT, "ok");
    const out = await safeDeepResearchPerson(PAT, CTX);
    expect(calls.deepResearchPerson).toBe(0);
    expect(out.receiptId).toBe(0);
    expect(out.result.status).toBe("completed");
    expect(out.result.cost).toBe(0);
  });

  it("refetches past the 90d expiry", async () => {
    seed(PAT, "ok", 91 * 24 * 3600 * 1000);
    await safeDeepResearchPerson(PAT, CTX);
    expect(calls.deepResearchPerson).toBe(1);
  });

  it("refetches through a corrupt cache row instead of throwing", async () => {
    seed(PAT, "ok", 0, "{not json");
    const out = await safeDeepResearchPerson(PAT, CTX);
    expect(calls.deepResearchPerson).toBe(1);
    expect(out.result.status).toBe("completed");
  });

  it("honours a negative cache entry without re-buying or logging a new error", async () => {
    seed(PAT, "failed");
    const out = await safeDeepResearchPerson(PAT, CTX);
    expect(calls.deepResearchPerson).toBe(0);
    expect(out.result.status).toBe("failed");
    expect(out.receiptId).toBe(0);
    expect(logged).not.toContain("error.swallowed");
  });

  it("cacheOnly answers from the cache or not at all", async () => {
    const miss = await safeDeepResearchPerson(PAT, CTX, { cacheOnly: true });
    expect(miss.result.status).toBe("failed");
    expect(calls.deepResearchPerson).toBe(0);
    expect(logged).not.toContain("error.swallowed");
    seed(PAT, "ok");
    const hit = await safeDeepResearchPerson(PAT, CTX, { cacheOnly: true });
    expect(hit.result.status).toBe("completed");
    expect(calls.deepResearchPerson).toBe(0);
    // No URL and no email: nothing to look up, cached or not.
    const none = await safeDeepResearchPerson({ name: "Pat" }, CTX, { cacheOnly: true });
    expect(none.result.status).toBe("failed");
  });

  it("negative-caches a GENUINE failure and returns the sentinel, never throwing", async () => {
    behaviour = "throw";
    const out = await safeDeepResearchPerson(PAT, CTX);
    expect(out.result.status).toBe("failed");
    expect(out.result.cost).toBe(0);
    expect(out.receiptId).toBe(0);
    expect(logged).toContain("error.swallowed");
    expect(stored(PAT)).toMatchObject({ status: "failed", message: "no data for this person" });
  });

  it("does NOT negative-cache a transient error", async () => {
    behaviour = "throw";
    thrownMessage = "tool execution failed";
    const out = await safeDeepResearchPerson(PAT, CTX);
    expect(out.result.status).toBe("failed");
    expect(stored(PAT)).toBeNull();
  });

  it("treats a deadline breach as transient — no negative cache", async () => {
    behaviour = "hang";
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/slow" }, CTX);
    expect(out.result.status).toBe("failed");
    expect(
      core.readPaidCache("research.person", { socialMediaUrl: "https://github.com/slow" }),
    ).toBeNull();
    // Let the abandoned purchase settle before the next test resets the cache.
    await new Promise((r) => setTimeout(r, 250));
  });

  it("still caches a call that settles AFTER the deadline — it was paid for", async () => {
    behaviour = "hang";
    const late = { socialMediaUrl: "https://github.com/late" };
    const out = await safeDeepResearchPerson(late, CTX);
    expect(out.result.status).toBe("failed");
    expect(stored(late)).toBeNull();
    // The abandoned promise keeps running; the cache stores it when it settles.
    await new Promise((r) => setTimeout(r, 250));
    expect(stored(late)?.status).toBe("ok");
  });

  it("buys again under `fresh` even when a result is cached", async () => {
    seed(PAT, "ok");
    const out = await safeDeepResearchPerson(PAT, CTX, { fresh: true });
    expect(calls.deepResearchPerson).toBe(1);
    expect(out.receiptId).toBe(9);
  });
});
