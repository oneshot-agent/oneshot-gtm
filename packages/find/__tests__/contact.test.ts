import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveAndVerifyContact composes the real safeFindEmail/safeVerifyEmail
// (which call the mocked core findEmail/verifyEmail) + a mocked prescreen.

let findFound = true;
let findCost = 0.01;
let verifyDeliverable = true;
let prescreenOk = true;
let findCalls = 0;
let verifyCalls = 0;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    findEmail: async () => {
      findCalls++;
      return {
        result: {
          status: "ok",
          email: findFound ? "found@acme.dev" : null,
          found: findFound,
          full_name: "Found Name",
          cost: findCost,
        },
        receiptId: 1,
      };
    },
    verifyEmail: async ({ email }: { email: string }) => {
      verifyCalls++;
      return {
        result: {
          status: "ok",
          email,
          valid: verifyDeliverable,
          deliverable: verifyDeliverable,
          catch_all: false,
          disposable: false,
          cost: 0.005,
        },
        receiptId: 1,
      };
    },
  };
});
vi.mock("../src/_findemail-prescreen.ts", () => ({
  shouldSkipFindEmail: () => (prescreenOk ? { ok: true } : { ok: false, reason: "role-account" }),
}));

const { resolveAndVerifyContact } = await import("../src/_contact.ts");

beforeEach(() => {
  findFound = true;
  findCost = 0.01;
  verifyDeliverable = true;
  prescreenOk = true;
  findCalls = 0;
  verifyCalls = 0;
});

describe("resolveAndVerifyContact", () => {
  it("resolves, verifies, and accumulates find + verify cost on the happy path", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "Input Name",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({
      ok: true,
      email: "found@acme.dev",
      fullName: "Found Name",
      costUsd: 0.015,
    });
  });

  it("drops with no-domain when neither knownEmail nor companyDomain is given", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: null,
    });
    expect(res).toEqual({ ok: false, reason: "no-domain", costUsd: 0 });
    expect(findCalls).toBe(0);
  });

  it("drops with prescreen (and skips findEmail) when the prescreen gate fails", async () => {
    prescreenOk = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({ ok: false, reason: "prescreen", costUsd: 0 });
    expect(findCalls).toBe(0);
  });

  it("drops with not-found but still reports the find cost", async () => {
    findFound = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({ ok: false, reason: "not-found", costUsd: 0.01 });
    expect(verifyCalls).toBe(0);
  });

  it("drops a duplicate BEFORE verify (no verify spend)", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
      isDuplicate: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "duplicate", costUsd: 0.01 });
    expect(verifyCalls).toBe(0);
  });

  it("drops with undeliverable when verify says so", async () => {
    verifyDeliverable = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({ ok: false, reason: "undeliverable", costUsd: 0.015 });
  });

  it("skips findEmail when knownEmail is supplied and keeps the caller's fullName", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "Caller Name",
      knownEmail: "known@acme.dev",
    });
    expect(res).toEqual({
      ok: true,
      email: "known@acme.dev",
      fullName: "Caller Name",
      costUsd: 0.005,
    });
    expect(findCalls).toBe(0);
    expect(verifyCalls).toBe(1);
  });
});
