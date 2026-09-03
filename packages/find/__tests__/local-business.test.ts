import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// local-business is the only finder built on `peopleSearch`/`companySearch`
// instead of the per-candidate resolve spine. The crux under test: a
// `best_work_email` on the search result routes to the cheap lane (skip
// findEmail/verifyEmail, straight to the person gate) while its absence
// falls back to the normal `resolveVerifyEnrichQualify` spine — and business-
// shaped targeting (industries set, no jobTitles) runs `companySearch` first
// and feeds its domains into `peopleSearch`. Mock the module boundaries the
// finder calls (SDK-safe wrappers, ICP/person filter, enrich, dedupe, ledger).

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}
const enqueued: EnqueuedRow[] = [];
let icpMatch: boolean | null = true;
let personVerdict: "pass" | "reject" | "unclear" | "transient" = "pass";

interface StubPerson {
  full_name?: string;
  title?: string;
  company?: string;
  company_domain?: string;
  linkedin_url?: string;
  best_work_email?: string;
  phone?: string;
  email?: string;
}
interface StubCompany {
  name?: string;
  domain?: string;
  industry?: string;
}

let nextPeopleSearchResults: StubPerson[] = [];
let nextCompanySearchResults: StubCompany[] = [];
const peopleSearchCalls: Array<Record<string, unknown>> = [];
const companySearchCalls: Array<Record<string, unknown>> = [];
const findEmailCalls: string[] = [];
const verifyEmailCalls: string[] = [];

vi.mock("../src/_sdk-safe.ts", () => ({
  safePeopleSearch: async (input: Record<string, unknown>) => {
    peopleSearchCalls.push(input);
    return {
      result: {
        status: "ok",
        results: nextPeopleSearchResults,
        total_found: nextPeopleSearchResults.length,
        cost: 0.01,
      },
      receiptId: 1,
    };
  },
  safeCompanySearch: async (input: Record<string, unknown>) => {
    companySearchCalls.push(input);
    return {
      result: {
        status: "ok",
        results: nextCompanySearchResults,
        total_found: nextCompanySearchResults.length,
        cost: 0.01,
      },
      receiptId: 1,
    };
  },
  safeFindEmail: async (input: { companyDomain?: string | null }) => {
    findEmailCalls.push(input.companyDomain ?? "");
    return { result: { found: true, email: "resolved@acme.dev", cost: 0.005 }, receiptId: 2 };
  },
  safeVerifyEmail: async (input: { email: string }) => {
    verifyEmailCalls.push(input.email);
    return { result: { deliverable: true, cost: 0.006 }, receiptId: 3 };
  },
}));

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({
    match: icpMatch,
    reason: icpMatch === null ? "icp classifier unavailable" : icpMatch ? "fits" : "nope",
  }),
  hasRoleText: (p: { roleText?: string | null }) => (p.roleText ?? "").trim().length > 0,
  qualifyPerson: async () => ({ verdict: personVerdict, reason: "stub" }),
}));

vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    title: null,
    summary: null,
    costUsd: 0.005,
    receiptId: 4,
  }),
}));

vi.mock("../src/_dedupe.ts", () => ({ isDuplicate: () => false }));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      isQueueDuplicate: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runLocalBusinessFinder } = await import("../src/local-business.ts");

const basePerson: StubPerson = {
  full_name: "Dana Rivera",
  title: "Owner",
  company: "Rivera HVAC",
  company_domain: "riverahvac.com",
  linkedin_url: "https://www.linkedin.com/in/dana-rivera",
};

beforeEach(() => {
  enqueued.length = 0;
  icpMatch = true;
  personVerdict = "pass";
  nextPeopleSearchResults = [];
  nextCompanySearchResults = [];
  peopleSearchCalls.length = 0;
  companySearchCalls.length = 0;
  findEmailCalls.length = 0;
  verifyEmailCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runLocalBusinessFinder — lane routing on best_work_email", () => {
  it("skips findEmail/verifyEmail entirely when best_work_email is present (lane 1)", async () => {
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free scheduling setup",
    });

    expect(findEmailCalls).toHaveLength(0);
    expect(verifyEmailCalls).toHaveLength(0);
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("free-pilot");
    expect(row.payload["email"]).toBe("dana@riverahvac.com");
    expect(row.payload["businessType"]).toBeTruthy();
  });

  it("costs approximately one search call, not one call per candidate, when every result has best_work_email", async () => {
    // The whole point of the finder: N candidates, all with best_work_email,
    // must not multiply the per-candidate findEmail+verifyEmail spend.
    nextPeopleSearchResults = Array.from({ length: 5 }, (_, i) => ({
      full_name: `Owner ${i}`,
      title: "Owner",
      company: `Business ${i}`,
      company_domain: `biz${i}.com`,
      best_work_email: `owner${i}@biz${i}.com`,
    }));
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free setup",
    });

    expect(out.enqueued).toBe(5);
    expect(findEmailCalls).toHaveLength(0);
    expect(verifyEmailCalls).toHaveLength(0);
    // One $0.01 peopleSearch call total, no per-candidate resolve spend —
    // against ~5 * $0.011 = $0.055 the old per-candidate spine would cost.
    expect(out.costUsd).toBeCloseTo(0.01, 5);
    expect(peopleSearchCalls).toHaveLength(1);
  });

  it("falls back to resolveVerifyEnrichQualify when best_work_email is absent (lane 2)", async () => {
    nextPeopleSearchResults = [{ ...basePerson }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free setup",
    });

    expect(findEmailCalls).toEqual(["riverahvac.com"]);
    expect(verifyEmailCalls).toEqual(["resolved@acme.dev"]);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["email"]).toBe("resolved@acme.dev");
    // search cost + findEmail + verify + enrich, all real per-candidate spend.
    expect(out.costUsd).toBeCloseTo(0.01 + 0.005 + 0.006 + 0.005, 5);
  });
});

describe("runLocalBusinessFinder — business-shaped targeting", () => {
  it("runs companySearch first and feeds company_domains into peopleSearch when industries is set and jobTitles is empty", async () => {
    nextCompanySearchResults = [
      { name: "Smile Dental", domain: "smiledental.com", industry: "Dental Practices" },
      { name: "Bright Teeth", domain: "brightteeth.com", industry: "Dental Practices" },
    ];
    nextPeopleSearchResults = [
      {
        full_name: "Pat Lee",
        title: "Practice Manager",
        company: "Smile Dental",
        company_domain: "smiledental.com",
        best_work_email: "pat@smiledental.com",
      },
    ];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      industries: ["Dental Practices"],
      yourEdge: "free intake form setup",
    });

    expect(companySearchCalls).toHaveLength(1);
    expect(companySearchCalls[0]?.["industry"]).toEqual(["Dental Practices"]);
    expect(peopleSearchCalls).toHaveLength(1);
    expect(peopleSearchCalls[0]?.["companyDomains"]).toEqual([
      "smiledental.com",
      "brightteeth.com",
    ]);
    // Business-shaped targeting doesn't pass industry directly to peopleSearch
    // — the resolved domains carry the targeting instead.
    expect(peopleSearchCalls[0]?.["industry"]).toBeUndefined();
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["businessType"]).toBe("Dental Practices");
  });

  it("halts without calling peopleSearch when companySearch returns no companies", async () => {
    nextCompanySearchResults = [];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      industries: ["Dental Practices"],
      yourEdge: "x",
    });
    expect(peopleSearchCalls).toHaveLength(0);
    expect(out.enqueued).toBe(0);
    expect(out.halted).toBeTruthy();
  });
});

describe("runLocalBusinessFinder — ICP gate and limits", () => {
  it("persists a rejected row instead of a target when the ICP filter misses", async () => {
    icpMatch = false;
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "x",
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.initialStatus).toBe("rejected");
    expect(enqueued[0]?.playName).toBe("free-pilot");
  });

  it("does NOT persist a rejected row when the classifier is transiently unavailable (match=null)", async () => {
    icpMatch = null;
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "x",
    });
    expect(enqueued).toHaveLength(0);
  });

  it("respects the enqueue limit", async () => {
    nextPeopleSearchResults = Array.from({ length: 5 }, (_, i) => ({
      full_name: `Owner ${i}`,
      title: "Owner",
      company: `Business ${i}`,
      company_domain: `biz${i}.com`,
      best_work_email: `owner${i}@biz${i}.com`,
    }));
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      limit: 2,
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(2);
  });

  it("persists a rejected row instead of a target when the person-level role gate rejects", async () => {
    personVerdict = "reject";
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedRole).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.initialStatus).toBe("rejected");
  });
});
