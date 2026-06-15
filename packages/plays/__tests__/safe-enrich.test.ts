import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Negative-caching contract for safeEnrich: failures are recorded so the next
// draft/regenerate of the same prospect skips the ~70s SDK retry, and
// standardEnrich surfaces the failure on the Prepared result.

const calls = { enrichProfile: 0 };
let throwOnNextCall = false;
let nextThrowMessage = "no profile data";
const cache = {
  setCalls: [] as Array<{ key: string }>,
  failureCalls: [] as Array<{ key: string; message: string }>,
  cachedRow: null as { result_json: string; fetched_at: string; status?: string | null } | null,
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    enrichProfile: async () => {
      calls.enrichProfile++;
      if (throwOnNextCall) {
        throwOnNextCall = false;
        throw new Error(nextThrowMessage);
      }
      return {
        result: { status: "completed", profile: { full_name: "Pat" }, cost: 0.005 },
        receiptId: 7,
      };
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

const { safeEnrich } = await import("../src/_lib.ts");
const { standardEnrich } = await import("../src/_run-play.ts");

beforeEach(() => {
  calls.enrichProfile = 0;
  throwOnNextCall = false;
  nextThrowMessage = "no profile data";
  cache.setCalls = [];
  cache.failureCalls = [];
  cache.cachedRow = null;
});

afterEach(() => vi.clearAllMocks());

describe("safeEnrich — negative caching", () => {
  it("records a failure entry for a GENUINE no-data failure", async () => {
    throwOnNextCall = true;
    nextThrowMessage = "no profile data";
    const out = await safeEnrich({ email: "Bad@X.dev" }, { playName: "show-hn" });
    expect((out.result as { status?: string }).status).toBe("failed");
    expect(cache.failureCalls).toEqual([{ key: "bad@x.dev", message: "no profile data" }]);
  });

  it("does NOT negative-cache a TRANSIENT platform error (avoids the 3-day poison)", async () => {
    throwOnNextCall = true;
    nextThrowMessage = "Job failed: Tool execution failed. (ref: abc)";
    const out = await safeEnrich({ email: "bad@x.dev" }, { playName: "show-hn" });
    // Still returns the failed shape (draft proceeds without enrichment)...
    expect((out.result as { status?: string }).status).toBe("failed");
    // ...but the cache is NOT poisoned, so a later draft re-attempts.
    expect(cache.failureCalls).toHaveLength(0);
  });

  it("a fresh failed entry returns the failed shape with zero SDK calls", async () => {
    cache.cachedRow = {
      result_json: JSON.stringify({ failed: true, message: "timeout" }),
      fetched_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
      status: "failed",
    };
    const out = await safeEnrich({ email: "bad@x.dev" }, { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(0);
    expect((out.result as { status?: string }).status).toBe("failed");
    expect(out.receiptId).toBe(0);
  });

  it("an expired failed entry retries and re-caches on success", async () => {
    cache.cachedRow = {
      result_json: JSON.stringify({ failed: true, message: "timeout" }),
      fetched_at: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString(), // > 3d TTL
      status: "failed",
    };
    const out = await safeEnrich({ email: "bad@x.dev" }, { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(1);
    expect((out.result as { status?: string }).status).toBe("completed");
    expect(cache.setCalls).toEqual([{ key: "bad@x.dev" }]);
  });
});

describe("standardEnrich — enrichmentFailed marker", () => {
  it("sets enrichmentFailed when enrichment failed", async () => {
    throwOnNextCall = true;
    const prep = await standardEnrich({
      playName: "show-hn",
      enrichInput: { email: "bad@x.dev" },
      enrichSlice: 1000,
    });
    expect(prep.enrichmentFailed).toBe(true);
  });

  it("omits enrichmentFailed on success", async () => {
    const prep = await standardEnrich({
      playName: "show-hn",
      enrichInput: { email: "ok@x.dev" },
      enrichSlice: 1000,
    });
    expect(prep.enrichmentFailed).toBeUndefined();
    expect(prep.dossier).toContain("Pat");
  });
});
