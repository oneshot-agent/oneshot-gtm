import { describe, expect, it, vi } from "vitest";

// Unit-level proof that the safe wrappers never propagate a throw — a rejecting
// findEmail/verifyEmail (e.g. a OneShot backend "Job … timed out after N")
// resolves to a graceful "drop this candidate" sentinel instead of aborting
// the whole finder run.

let findThrow = false;
let verifyThrow = false;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    findEmail: async () => {
      if (findThrow) throw new Error("Job 035ebe1e timed out after 121");
      return { result: { status: "ok", email: "a@b.com", found: true, cost: 0.005 }, receiptId: 7 };
    },
    verifyEmail: async () => {
      if (verifyThrow) throw new Error("Job 035ebe1e timed out after 121");
      return {
        result: {
          status: "ok",
          email: "a@b.com",
          valid: true,
          deliverable: true,
          catch_all: false,
          disposable: false,
          cost: 0.005,
        },
        receiptId: 8,
      };
    },
  };
});

const { safeFindEmail, safeVerifyEmail } = await import("../src/_sdk-safe.ts");

describe("safeFindEmail / safeVerifyEmail", () => {
  it("passes through the real result on success", async () => {
    findThrow = false;
    verifyThrow = false;
    const found = await safeFindEmail({ companyDomain: "b.com", fullName: "A" }, { playName: "t" });
    expect(found.result.found).toBe(true);
    expect(found.result.email).toBe("a@b.com");
    expect(found.receiptId).toBe(7);

    const verified = await safeVerifyEmail({ email: "a@b.com" }, { playName: "t" });
    expect(verified.result.deliverable).toBe(true);
    expect(verified.receiptId).toBe(8);
  });

  it("resolves to a found:false sentinel (no throw) when findEmail rejects", async () => {
    findThrow = true;
    const found = await safeFindEmail({ companyDomain: "b.com", fullName: "A" }, { playName: "t" });
    expect(found.result.found).toBe(false);
    expect(found.result.email).toBeNull();
    expect(found.result.cost).toBe(0);
    expect(found.receiptId).toBe(0);
  });

  it("resolves to a deliverable:false sentinel (no throw) when verifyEmail rejects", async () => {
    verifyThrow = true;
    const verified = await safeVerifyEmail({ email: "a@b.com" }, { playName: "t" });
    expect(verified.result.deliverable).toBe(false);
    expect(verified.result.email).toBe("a@b.com");
    expect(verified.result.cost).toBe(0);
    expect(verified.receiptId).toBe(0);
  });
});
