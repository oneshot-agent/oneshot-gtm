import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotOwnerOperatorBuyer } from "@oneshot-gtm/plays";

// Correction round 1, F-t_1ec69ea6-1/2: exercises local-business's REAL
// enqueue call sites (both the b2b lane and the `local` engine) with
// `play`/`buyerType` routing set, rather than only
// `buildDesignPartnerLoiPayload` in isolation on hand-written input. The
// review specifically flagged the local engine's mapping as non-obvious:
// `company` comes from the business `name` local var while `name` (the
// person) comes from `contact.fullName ?? name` — the SAME business-name
// variable as a fallback. A helper test on hand-written input cannot catch a
// wire-up bug where those two get swapped or collapsed.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
}

const enqueued: EnqueuedRow[] = [];
const dedupeChecks: Array<{ playName: string; dedupeKey: string }> = [];
let queueDuplicateFor: Set<string> = new Set();
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
interface StubLocal {
  id?: string;
  name?: string;
  domain?: string | null;
  website?: string | null;
  phone?: string | null;
  category?: string | null;
  address?: string | null;
}

let nextPeopleSearchResults: StubPerson[] = [];
let nextLocalSearchResults: StubLocal[] = [];

vi.mock("../src/_sdk-safe.ts", () => ({
  safePeopleSearch: async () => ({
    result: {
      status: "ok",
      results: nextPeopleSearchResults,
      total_found: nextPeopleSearchResults.length,
      cost: 0.01,
    },
    receiptId: 1,
  }),
  safeCompanySearch: async () => ({
    result: { status: "ok", results: [], total_found: 0, cost: 0 },
    receiptId: 1,
  }),
  safeLocalSearch: async () => ({
    result: {
      status: "ok",
      results: nextLocalSearchResults,
      total_found: nextLocalSearchResults.length,
      truncated: false,
      vendor_calls: 1,
      cost: 0.02,
    },
    receiptId: 9,
  }),
  safeFindEmail: async () => ({
    result: { found: true, email: "resolved@acme-hvac.example", cost: 0.005 },
    receiptId: 2,
  }),
  safeVerifyEmail: async () => ({ result: { deliverable: true, cost: 0.006 }, receiptId: 3 }),
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
      isQueueDuplicate: (playName: string, dedupeKey: string) => {
        dedupeChecks.push({ playName, dedupeKey });
        return queueDuplicateFor.has(playName);
      },
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runLocalBusinessFinder } = await import("../src/local-business.ts");

beforeEach(() => {
  enqueued.length = 0;
  dedupeChecks.length = 0;
  queueDuplicateFor = new Set();
  icpMatch = true;
  personVerdict = "pass";
  nextPeopleSearchResults = [];
  nextLocalSearchResults = [];
});
afterEach(() => vi.clearAllMocks());

describe("runLocalBusinessFinder (b2b lane) — routed to design-partner-loi (#705)", () => {
  it("persists play_name=design-partner-loi with a payload the play's own guard accepts, `company` from the b2b result's company field", async () => {
    nextPeopleSearchResults = [
      {
        full_name: "Dana Rivera",
        title: "Owner",
        company: "Rivera HVAC",
        company_domain: "riverahvac.com",
        best_work_email: "dana@riverahvac.com",
      },
    ];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "we cut scheduling time in half",
      play: "design-partner-loi",
      buyerType: "enterprise",
    });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("design-partner-loi");

    const p = row.payload;
    expect(typeof p["name"]).toBe("string");
    expect(typeof p["email"]).toBe("string");
    expect(typeof p["company"]).toBe("string");
    expect(typeof p["buyerType"]).toBe("string");
    expect(() => assertNotOwnerOperatorBuyer(p["buyerType"] as string)).not.toThrow();

    expect(p["name"]).toBe("Dana Rivera");
    expect(p["company"]).toBe("Rivera HVAC");
    expect(p["email"]).toBe("dana@riverahvac.com");
    expect(p["yourEdge"]).toBe("we cut scheduling time in half");
    expect(p["buyerType"]).toBe("enterprise");

    // Not free-pilot's own shape.
    expect(p).not.toHaveProperty("businessType");
  });

  it("with the routing key absent, persists free-pilot's own unchanged shape under free-pilot", async () => {
    nextPeopleSearchResults = [
      {
        full_name: "Dana Rivera",
        title: "Owner",
        company: "Rivera HVAC",
        company_domain: "riverahvac.com",
        best_work_email: "dana@riverahvac.com",
      },
    ];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free scheduling setup",
    });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("free-pilot");
    expect(row.payload["businessType"]).toBeTruthy();
    expect(row.payload).not.toHaveProperty("buyerType");
  });

  it("checks queue dedupe against BOTH free-pilot and design-partner-loi regardless of routing", async () => {
    nextPeopleSearchResults = [
      { full_name: "Dana Rivera", title: "Owner", best_work_email: "dana@riverahvac.com" },
    ];
    await runLocalBusinessFinder({ dryRun: false, jobTitles: ["Owner"], yourEdge: "x" });
    const checkedPlays = new Set(dedupeChecks.map((c) => c.playName));
    expect(checkedPlays.has("free-pilot")).toBe(true);
    expect(checkedPlays.has("design-partner-loi")).toBe(true);
  });
});

describe("runLocalBusinessFinder (`local` engine) — routed to design-partner-loi (#705)", () => {
  const baseBiz: StubLocal = {
    id: "loc_abc",
    name: "Rivera Family Dental",
    domain: "riverafamilydental.example",
    website: "https://riverafamilydental.example",
    phone: "+1 512 555 0142",
    category: "dental practice",
    address: "100 Congress Ave, Austin, TX",
  };

  it("maps `company` from the business name and `name` (person) from contact.fullName ?? name — the mapping the review flagged as unmeasured", async () => {
    nextLocalSearchResults = [baseBiz];
    // Domain-scoped peopleSearch finds a named owner.
    nextPeopleSearchResults = [{ full_name: "Pat Owner", title: "Owner" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "we set up online booking free",
      play: "design-partner-loi",
      buyerType: "hardware",
    });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("design-partner-loi");

    const p = row.payload;
    expect(() => assertNotOwnerOperatorBuyer(p["buyerType"] as string)).not.toThrow();
    // company = the business name (the local var `name`), never the owner's.
    expect(p["company"]).toBe("Rivera Family Dental");
    // name = contact.fullName (peopleSearch found one) ?? the business name.
    expect(p["name"]).toBe("Pat Owner");
    expect(p["email"]).toBe("resolved@acme-hvac.example");
    expect(p["yourEdge"]).toBe("we set up online booking free");
  });

  it("drops the candidate (rather than enqueuing with a blank identity) when the domain-scoped lookup finds no named person", async () => {
    nextLocalSearchResults = [baseBiz];
    // No owner name on the places result AND no named person at the domain.
    nextPeopleSearchResults = [{}];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "x",
      play: "design-partner-loi",
      buyerType: "hardware",
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("with the routing key absent, persists the local engine's own free-pilot shape unchanged", async () => {
    nextLocalSearchResults = [baseBiz];
    nextPeopleSearchResults = [{ full_name: "Dana Rivera", title: "Owner" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "we set up online booking free",
    });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("free-pilot");
    expect(row.payload["businessType"]).toBe("dental practice");
    expect(row.payload).not.toHaveProperty("buyerType");
  });

  it("checks queue dedupe against BOTH free-pilot and design-partner-loi regardless of routing", async () => {
    nextLocalSearchResults = [baseBiz];
    nextPeopleSearchResults = [{ full_name: "Dana Rivera", title: "Owner" }];
    await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "x",
    });
    const checkedPlays = new Set(dedupeChecks.map((c) => c.playName));
    expect(checkedPlays.has("free-pilot")).toBe(true);
    expect(checkedPlays.has("design-partner-loi")).toBe(true);
  });
});
