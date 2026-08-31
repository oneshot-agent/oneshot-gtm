import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Caching + failure contract for safeDeepResearchPerson. This call is the most
// expensive and slowest in the toolbox (~$0.05, 2-5 min), so the rules that
// matter are: never re-buy a cached person, never hang forever, and never
// negative-cache a transient error (which would make someone un-researchable
// for the whole failure TTL after the platform recovers).

const calls = { deepResearchPerson: 0 };
let behaviour: "ok" | "throw" | "hang" = "ok";
let thrownMessage = "no data for this person";

const cache = {
  setCalls: [] as Array<{ key: string }>,
  failureCalls: [] as Array<{ key: string; message: string }>,
  cachedRow: null as { result_json: string; fetched_at: string; status?: string | null } | null,
};

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
    deepResearchPerson: async () => {
      calls.deepResearchPerson++;
      if (behaviour === "throw") throw new Error(thrownMessage);
      if (behaviour === "hang") await new Promise((r) => setTimeout(r, 200));
      return { result: RESULT, receiptId: 9 };
    },
    logEvent: () => {},
    getLedger: () => ({
      getCachedEnrichment: () => cache.cachedRow,
      setCachedEnrichment: (key: string) => cache.setCalls.push({ key }),
      setCachedEnrichmentFailure: (key: string, message: string) =>
        cache.failureCalls.push({ key, message }),
    }),
  };
});

const { safeDeepResearchPerson, personCacheKey } = await import("../src/_sdk-safe.ts");

const CTX = { playName: "test-play" };

beforeEach(() => {
  calls.deepResearchPerson = 0;
  behaviour = "ok";
  thrownMessage = "no data for this person";
  cache.setCalls = [];
  cache.failureCalls = [];
  cache.cachedRow = null;
});

afterEach(() => vi.clearAllMocks());

describe("personCacheKey", () => {
  it("prefers the social URL — it identifies a person more precisely than an email", () => {
    expect(personCacheKey({ socialMediaUrl: "https://GitHub.com/Pat", email: "pat@x.dev" })).toBe(
      "person:https://github.com/pat",
    );
  });

  it("falls back to the email, and is null when neither is usable", () => {
    expect(personCacheKey({ email: "Pat@X.dev" })).toBe("person:pat@x.dev");
    expect(personCacheKey({ name: "Pat" })).toBeNull();
    expect(personCacheKey({ socialMediaUrl: "  " })).toBeNull();
  });
});

describe("safeDeepResearchPerson", () => {
  it("caches a successful research under the person key", async () => {
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(out.receiptId).toBe(9);
    expect(calls.deepResearchPerson).toBe(1);
    expect(cache.setCalls).toEqual([{ key: "person:https://github.com/pat" }]);
  });

  it("serves a fresh cache hit for free — no SDK call, receiptId 0", async () => {
    cache.cachedRow = { result_json: JSON.stringify(RESULT), fetched_at: new Date().toISOString() };
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(calls.deepResearchPerson).toBe(0);
    expect(out.receiptId).toBe(0);
    expect(out.result.status).toBe("completed");
  });

  it("refetches past the 90d TTL", async () => {
    cache.cachedRow = {
      result_json: JSON.stringify(RESULT),
      fetched_at: new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString(),
    };
    await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(calls.deepResearchPerson).toBe(1);
  });

  it("refetches through a corrupt cache row instead of throwing", async () => {
    cache.cachedRow = { result_json: "{not json", fetched_at: new Date().toISOString() };
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(calls.deepResearchPerson).toBe(1);
    expect(out.result.status).toBe("completed");
  });

  it("honours a negative cache entry without re-buying", async () => {
    cache.cachedRow = {
      result_json: JSON.stringify({ failed: true }),
      fetched_at: new Date().toISOString(),
      status: "failed",
    };
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(calls.deepResearchPerson).toBe(0);
    expect(out.result.status).toBe("failed");
    expect(out.receiptId).toBe(0);
  });

  it("negative-caches a GENUINE failure and returns the sentinel, never throwing", async () => {
    behaviour = "throw";
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(out.result.status).toBe("failed");
    expect(out.result.cost).toBe(0);
    expect(out.receiptId).toBe(0);
    expect(cache.failureCalls).toEqual([
      { key: "person:https://github.com/pat", message: "no data for this person" },
    ]);
  });

  it("does NOT negative-cache a transient error", async () => {
    behaviour = "throw";
    thrownMessage = "tool execution failed";
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(out.result.status).toBe("failed");
    expect(cache.failureCalls).toEqual([]);
  });

  it("treats a deadline breach as transient — no negative cache", async () => {
    behaviour = "hang";
    const out = await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/pat" }, CTX);
    expect(out.result.status).toBe("failed");
    expect(cache.failureCalls).toEqual([]);
  });

  it("still caches a call that settles AFTER the deadline — it was paid for", async () => {
    behaviour = "hang";
    // Distinct key: the previous hang test's abandoned promise also settles
    // during the wait below, so the assertion has to be attributable.
    const key = "person:https://github.com/late";
    await safeDeepResearchPerson({ socialMediaUrl: "https://github.com/late" }, CTX);
    expect(cache.setCalls.map((c) => c.key)).not.toContain(key);
    // The abandoned promise keeps running; its cache write lands when it settles.
    await new Promise((r) => setTimeout(r, 250));
    expect(cache.setCalls.map((c) => c.key)).toContain(key);
  });

  it("runs uncached when there is no key to cache under", async () => {
    const out = await safeDeepResearchPerson({ name: "Pat" }, CTX);
    expect(calls.deepResearchPerson).toBe(1);
    expect(out.receiptId).toBe(9);
    expect(cache.setCalls).toEqual([]);
  });
});
