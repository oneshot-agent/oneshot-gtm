import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Failure contract for safeEnrich: the paid cache under enrichProfile keeps a
// genuine failure so the next draft/regenerate of the same prospect skips the
// ~70s SDK retry, and standardEnrich surfaces the failure on the Prepared
// result. The mock runs the real paid cache around a fake purchase.

const calls = { enrichProfile: 0 };
let throwOnNextCall = false;
let nextThrowMessage = "no profile data";
const logged: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    enrichProfile: (input: unknown, _ctx: unknown, cache?: unknown) =>
      actual.withPaidCache("enrich.profile", input, cache as never, async () => {
        calls.enrichProfile++;
        if (throwOnNextCall) {
          throwOnNextCall = false;
          throw new Error(nextThrowMessage);
        }
        return {
          result: { status: "completed", profile: { full_name: "Pat" }, cost: 0.005 },
          receiptId: 7,
        };
      }),
    logEvent: (name: string) => {
      logged.push(name);
    },
  };
});

const core = await import("@oneshot-gtm/core");
const { safeEnrich } = await import("../src/_lib.ts");
const { standardEnrich } = await import("../src/_run-play.ts");

function seedFailure(email: string, ageMs: number): void {
  core.getSharedDb().setPaidCache({
    key: core.paidCacheKey("enrich.profile", { email }),
    callType: "enrich.profile",
    status: "failed",
    resultJson: JSON.stringify({ message: "timeout" }),
    costUsd: null,
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

beforeEach(() => {
  calls.enrichProfile = 0;
  throwOnNextCall = false;
  nextThrowMessage = "no profile data";
  logged.length = 0;
  core._resetPaidCache();
});

afterEach(() => vi.clearAllMocks());

describe("safeEnrich — negative caching", () => {
  it("a GENUINE no-data failure is remembered for the address", async () => {
    throwOnNextCall = true;
    nextThrowMessage = "no profile data";
    const out = await safeEnrich({ email: "Bad@X.dev" }, { playName: "show-hn" });
    expect((out.result as { status?: string }).status).toBe("failed");
    expect(logged).toContain("enrich.failed");
    expect(core.readPaidCache("enrich.profile", { email: "bad@x.dev" })).toMatchObject({
      status: "failed",
      message: "no profile data",
    });
  });

  it("does NOT negative-cache a TRANSIENT platform error (avoids the 3-day poison)", async () => {
    throwOnNextCall = true;
    nextThrowMessage = "Job failed: Tool execution failed. (ref: abc)";
    const out = await safeEnrich({ email: "bad@x.dev" }, { playName: "show-hn" });
    // Still returns the failed shape (draft proceeds without enrichment)...
    expect((out.result as { status?: string }).status).toBe("failed");
    // ...but the cache is NOT poisoned, so a later draft re-attempts.
    expect(core.readPaidCache("enrich.profile", { email: "bad@x.dev" })).toBeNull();
  });

  it("a fresh failed entry returns the failed shape with zero SDK calls and no new log", async () => {
    seedFailure("bad@x.dev", 3600_000); // 1h ago
    const out = await safeEnrich({ email: "bad@x.dev" }, { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(0);
    expect((out.result as { status?: string }).status).toBe("failed");
    expect(out.receiptId).toBe(0);
    expect(logged).not.toContain("enrich.failed");
  });

  it("an expired failed entry retries and re-caches on success", async () => {
    seedFailure("bad@x.dev", 4 * 24 * 3600 * 1000); // > 3d
    const out = await safeEnrich({ email: "bad@x.dev" }, { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(1);
    expect((out.result as { status?: string }).status).toBe("completed");
    expect(core.readPaidCache("enrich.profile", { email: "bad@x.dev" })?.status).toBe("ok");
    // The next call is a free hit.
    const again = await safeEnrich({ email: "BAD@x.dev" }, { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(1);
    expect(again.receiptId).toBe(0);
    expect(again.result.cost).toBe(0);
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
