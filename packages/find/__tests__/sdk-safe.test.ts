import { describe, expect, it, vi } from "vitest";

// Unit-level proof that the safe wrappers never propagate a throw — a rejecting
// findEmail/verifyEmail (e.g. a OneShot backend "Job … timed out after N")
// resolves to a graceful "drop this candidate" sentinel instead of aborting
// the whole finder run.

let findThrow = false;
let verifyThrow = false;
let peopleSearchThrow = false;
let companySearchThrow = false;
let enrichCompanyThrow = false;

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
    peopleSearch: async () => {
      if (peopleSearchThrow) throw new Error("Job 035ebe1e timed out after 121");
      return {
        result: {
          status: "ok",
          results: [{ full_name: "Pat Lee", best_work_email: "pat@b.com" }],
          total_found: 1,
          cost: 0.01,
        },
        receiptId: 11,
      };
    },
    companySearch: async () => {
      if (companySearchThrow) throw new Error("Job 035ebe1e timed out after 121");
      return {
        result: {
          status: "ok",
          results: [{ name: "Acme", domain: "acme.com" }],
          total_found: 1,
          cost: 0.01,
        },
        receiptId: 12,
      };
    },
    enrichCompany: async () => {
      if (enrichCompanyThrow) throw new Error("Job 035ebe1e timed out after 121");
      return {
        result: { status: "ok", company: { name: "Acme", domain: "acme.com" }, cost: 0.005 },
        receiptId: 13,
      };
    },
  };
});

const { safeFindEmail, safeVerifyEmail, safePeopleSearch, safeCompanySearch, safeEnrichCompany } =
  await import("../src/_sdk-safe.ts");

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

describe("safePeopleSearch", () => {
  it("passes through the real result on success", async () => {
    peopleSearchThrow = false;
    const out = await safePeopleSearch({ jobTitles: ["Owner"] }, { playName: "t" });
    expect(out.result.total_found).toBe(1);
    expect(out.result.results[0]?.best_work_email).toBe("pat@b.com");
    expect(out.receiptId).toBe(11);
  });

  it("resolves to an empty result set (no throw) when peopleSearch rejects", async () => {
    peopleSearchThrow = true;
    const out = await safePeopleSearch({ jobTitles: ["Owner"] }, { playName: "t" });
    expect(out.result.results).toEqual([]);
    expect(out.result.total_found).toBe(0);
    expect(out.result.cost).toBe(0);
    expect(out.receiptId).toBe(0);
  });
});

describe("safeCompanySearch", () => {
  it("passes through the real result on success", async () => {
    companySearchThrow = false;
    const out = await safeCompanySearch({ domain: "acme.com" }, { playName: "t" });
    expect(out.result.total_found).toBe(1);
    expect(out.result.results[0]?.name).toBe("Acme");
    expect(out.receiptId).toBe(12);
  });

  it("resolves to an empty result set (no throw) when companySearch rejects", async () => {
    companySearchThrow = true;
    const out = await safeCompanySearch({ domain: "acme.com" }, { playName: "t" });
    expect(out.result.results).toEqual([]);
    expect(out.result.total_found).toBe(0);
    expect(out.result.cost).toBe(0);
    expect(out.receiptId).toBe(0);
  });
});

describe("safeEnrichCompany", () => {
  it("passes through the real result on success", async () => {
    enrichCompanyThrow = false;
    const out = await safeEnrichCompany({ domain: "acme.com" }, { playName: "t" });
    expect(out.result.company.name).toBe("Acme");
    expect(out.receiptId).toBe(13);
  });

  it("resolves to an empty company sentinel (no throw) when enrichCompany rejects", async () => {
    enrichCompanyThrow = true;
    const out = await safeEnrichCompany({ domain: "acme.com" }, { playName: "t" });
    expect(out.result.company).toEqual({});
    expect(out.result.cost).toBe(0);
    expect(out.receiptId).toBe(0);
  });
});
