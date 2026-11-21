import { beforeEach, describe, expect, it, vi } from "vitest";

// A paid call whose input already has a payment hold is refused locally:
// nothing was sent or paid. The finder skips that one person and carries on.
// A new uncertain outcome is different: the run stops spending. Measured
// 2026-11: one held verifyEmail failed 41 local-business runs in a row and
// queued nobody for four days.
//
// The real safe wrappers and contact spine run here; only the SDK calls, the
// gates and the ledger are stubbed.

const { held, events, enqueued, sdk } = vi.hoisted(() => ({
  held: { find: new Set<string>(), verify: new Set<string>(), fresh: null as Error | null },
  events: [] as Array<{ event: string; data: Record<string, unknown> }>,
  enqueued: [] as Array<{ payload: Record<string, unknown> }>,
  sdk: { findCalls: 0, verifyCalls: 0, enrich: null as Error | null },
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  const refusal = (key: string) =>
    new actual.PaymentHeldError(key, undefined, { executionUncertain: true, localRefusal: true });
  return {
    ...actual,
    logEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    getLedger: () => ({
      isQueueDuplicate: () => false,
      getProductResearchCache: () => null,
      setProductResearchCache: () => {},
      isLinkedInProfileKnown: () => false,
      enqueueTarget: (row: { payload: Record<string, unknown> }) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
    peopleSearch: async () => ({
      result: {
        status: "ok",
        results: ["one", "held-find", "two", "held-verify", "three"].map((d) => ({
          full_name: `Owner ${d}`,
          title: "Owner",
          company: `Biz ${d}`,
          company_domain: `${d}.example`,
        })),
        total_found: 5,
        cost: 0.01,
      },
      receiptId: 1,
    }),
    findEmail: async ({ companyDomain }: { companyDomain: string }) => {
      sdk.findCalls++;
      if (held.find.has(companyDomain)) throw refusal(`find-${companyDomain}`);
      return {
        result: { status: "ok", email: `owner@${companyDomain}`, found: true, cost: 0.005 },
        receiptId: 2,
      };
    },
    verifyEmail: async ({ email }: { email: string }) => {
      sdk.verifyCalls++;
      if (held.fresh && email.endsWith("@two.example")) throw held.fresh;
      if (held.verify.has(email)) throw refusal(`verify-${email}`);
      return {
        result: {
          status: "ok",
          email,
          valid: true,
          deliverable: true,
          catch_all: false,
          disposable: false,
          cost: 0.006,
        },
        receiptId: 3,
      };
    },
    enrichProfile: async () => {
      if (sdk.enrich) throw sdk.enrich;
      return { result: { status: "completed", profile: {}, cost: 0.02 }, receiptId: 4 };
    },
  };
});
vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({ match: true, reason: "fits" }),
  hasRoleText: (p: { roleText?: string | null }) => (p.roleText ?? "").trim().length > 0,
  qualifyPerson: async () => ({ verdict: "pass", reason: "stub" }),
}));
vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    title: null,
    summary: null,
    costUsd: 0,
  }),
}));
vi.mock("../src/_dedupe.ts", () => ({ isDuplicate: () => false }));

const { PaymentHeldError } = await import("@oneshot-gtm/core");
const { runLocalBusinessFinder } = await import("../src/local-business.ts");
const { resolveAndVerifyContact, resolveViaProfileFallback } = await import("../src/_contact.ts");
const { _resetBreaker, isCircuitOpen } = await import("../src/_breaker.ts");

const run = () =>
  runLocalBusinessFinder({ dryRun: false, jobTitles: ["Owner"], yourEdge: "free setup" });
const skipped = () => events.filter((e) => e.event === "finder.skipped_held").map((e) => e.data);
const queued = () => enqueued.map((r) => r.payload["email"]);

beforeEach(() => {
  held.find.clear();
  held.verify.clear();
  held.fresh = null;
  events.length = 0;
  enqueued.length = 0;
  sdk.findCalls = 0;
  sdk.verifyCalls = 0;
  sdk.enrich = null;
  _resetBreaker();
});

describe("a finder run meeting a held lookup", () => {
  it("skips the person whose findEmail or verifyEmail is held and queues everyone else", async () => {
    held.find.add("held-find.example");
    held.verify.add("owner@held-verify.example");
    const out = await run();
    expect(queued()).toEqual(["owner@one.example", "owner@two.example", "owner@three.example"]);
    expect(out.enqueued).toBe(3);
    expect(out.halted).toBeUndefined();
    expect(skipped()).toEqual([
      { name: "free-pilot", method: "find_email", key: "find-held-find.example" },
      { name: "free-pilot", method: "verify_email", key: "verify-owner@held-verify.example" },
    ]);
    expect(events.map((e) => e.event)).not.toContain("error.swallowed");
  });

  it("still stops the run on a new uncertain outcome", async () => {
    held.fresh = new PaymentHeldError("fresh", undefined, { executionUncertain: true });
    await expect(run()).rejects.toThrow(/Paid call outcome unresolved/);
    // The two people before it were queued; nobody after it was tried.
    expect(queued()).toEqual(["owner@one.example", "owner@held-find.example"]);
    expect(sdk.verifyCalls).toBe(3);
  });

  it("still stops the run on an ambiguous settlement", async () => {
    const ambiguous = new Error("settlement did not confirm");
    ambiguous.name = "SettlementAmbiguousError";
    held.fresh = ambiguous;
    await expect(run()).rejects.toBe(ambiguous);
    expect(skipped()).toEqual([]);
  });
});

describe("a held lookup and the circuit breaker", () => {
  const call = () =>
    resolveAndVerifyContact({
      playName: "t",
      fullName: "Ada Byron",
      companyDomain: "held-find.example",
    });

  it("is a miss, not an outage: any number of them never opens the breaker", async () => {
    held.find.add("held-find.example");
    for (let i = 0; i < 8; i++) {
      expect(await call()).toEqual({ ok: false, reason: "not-found", costUsd: 0 });
    }
    expect(sdk.findCalls).toBe(8);
    expect(isCircuitOpen()).toBe(false);
    expect(events.map((e) => e.event)).not.toContain("finder.circuit_open");
  });

  it("does not end a run of platform errors either: it never reached OneShot", async () => {
    sdk.enrich = new Error("Job failed: Tool execution failed.");
    const fallback = () =>
      resolveViaProfileFallback(
        {
          playName: "t",
          fullName: "A",
          companyDomain: null,
          linkedinUrlHint: "https://www.linkedin.com/in/someone",
        },
        { ok: false, reason: "no-domain", costUsd: 0 },
      );
    for (let i = 0; i < 4; i++)
      expect(await fallback()).toMatchObject({ reason: "platform-error" });
    sdk.enrich = new PaymentHeldError("held", undefined, { localRefusal: true });
    // A held profile lookup is the original no-domain miss.
    expect(await fallback()).toEqual({ ok: false, reason: "no-domain", costUsd: 0 });
    expect(skipped()).toEqual([{ name: "t", method: "no_domain_enrich", key: "held" }]);
    sdk.enrich = new Error("Job failed: Tool execution failed.");
    await fallback();
    expect(isCircuitOpen()).toBe(true);
  });

  it("a new uncertain outcome in the profile fallback still throws", async () => {
    sdk.enrich = new PaymentHeldError("fresh", undefined, { executionUncertain: true });
    await expect(
      resolveViaProfileFallback(
        {
          playName: "t",
          fullName: "A",
          companyDomain: null,
          linkedinUrlHint: "https://www.linkedin.com/in/someone",
        },
        { ok: false, reason: "no-domain", costUsd: 0 },
      ),
    ).rejects.toBe(sdk.enrich);
  });
});
