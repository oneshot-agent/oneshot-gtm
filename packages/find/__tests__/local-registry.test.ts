import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dedupeKeyFor, routePlayFor } from "../src/local-registry.ts";
import type { RegistryRecord } from "../src/_registry-sources.ts";

describe("dedupeKeyFor", () => {
  it("is stable for the same source/name/state regardless of casing/spacing", () => {
    const a: RegistryRecord = {
      name: "Rae's Taqueria",
      address: null,
      city: null,
      state: "NY",
      phone: null,
      matchedDateIso: "2026-06-01T00:00:00Z",
      source: "socrata-license",
      sourceLabel: "NYC licenses",
    };
    const b: RegistryRecord = { ...a, name: "RAE'S   TAQUERIA" };
    expect(dedupeKeyFor(a)).toBe(dedupeKeyFor(b));
  });

  it("differs by source even for the same name/state", () => {
    const base: RegistryRecord = {
      name: "Rae's Dental",
      address: null,
      city: null,
      state: "NY",
      phone: null,
      matchedDateIso: "2026-06-01T00:00:00Z",
      source: "socrata-license",
      sourceLabel: "x",
    };
    expect(dedupeKeyFor(base)).not.toBe(dedupeKeyFor({ ...base, source: "nppes" }));
  });
});

describe("routePlayFor", () => {
  it("routes a record inside the freshness window to new-business", () => {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(routePlayFor(recent, 21)).toBe("new-business");
  });

  it("routes a record outside the freshness window to free-pilot", () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(routePlayFor(old, 21)).toBe("free-pilot");
  });

  it("treats the boundary (exactly freshnessDays old) as still fresh", () => {
    const boundary = new Date(Date.now() - 21 * 86_400_000).toISOString();
    expect(routePlayFor(boundary, 21)).toBe("new-business");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline — mock the boundaries the finder calls, idiom of
// packages/find/__tests__/github-stars.test.ts.
// ---------------------------------------------------------------------------

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
let nextSocrataRecords: RegistryRecord[] = [];
let nextNppesRecords: RegistryRecord[] = [];
let nextFmcsaRecords: RegistryRecord[] = [];
let nextInspectionRecords: RegistryRecord[] = [];
let socrataShouldThrow = false;
let nppesShouldThrow = false;
let fmcsaShouldThrow = false;
let inspectionShouldThrow = false;

const RECENT_ISO = new Date(Date.now() - 3 * 86_400_000).toISOString();
const OLD_ISO = new Date(Date.now() - 90 * 86_400_000).toISOString();

vi.mock("../src/_registry-sources.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_registry-sources.ts")>(
    "../src/_registry-sources.ts",
  );
  return {
    ...actual,
    REGISTRY_SOURCES: [
      {
        id: "socrata-license",
        fetch: async () => {
          if (socrataShouldThrow) throw new Error("socrata boom");
          return {
            records: nextSocrataRecords,
            costUsd: 0,
            perSource: nextSocrataRecords.map((r) => ({
              source: r.sourceLabel,
              label: r.sourceLabel,
              records: 1,
            })),
          };
        },
      },
      {
        id: "nppes",
        fetch: async () => {
          if (nppesShouldThrow) throw new Error("nppes boom");
          return {
            records: nextNppesRecords,
            costUsd: 0,
            perSource:
              nextNppesRecords.length > 0
                ? nextNppesRecords.map((r) => ({
                    source: r.sourceLabel,
                    label: r.sourceLabel,
                    records: 1,
                  }))
                : [{ source: "nppes", label: "nppes", records: 0, error: "no records" }],
          };
        },
      },
      {
        id: "fmcsa",
        fetch: async () => {
          if (fmcsaShouldThrow) throw new Error("fmcsa boom");
          return {
            records: nextFmcsaRecords,
            costUsd: 0,
            perSource:
              nextFmcsaRecords.length > 0
                ? nextFmcsaRecords.map((r) => ({
                    source: r.sourceLabel,
                    label: r.sourceLabel,
                    records: 1,
                  }))
                : [{ source: "fmcsa", label: "fmcsa", records: 0, error: "no records" }],
          };
        },
      },
      {
        id: "socrata-inspection",
        fetch: async () => {
          if (inspectionShouldThrow) throw new Error("inspection boom");
          return {
            records: nextInspectionRecords,
            costUsd: 0,
            perSource:
              nextInspectionRecords.length > 0
                ? nextInspectionRecords.map((r) => ({
                    source: r.sourceLabel,
                    label: r.sourceLabel,
                    records: 1,
                  }))
                : [
                    {
                      source: "socrata-inspection",
                      label: "socrata-inspection",
                      records: 0,
                      error: "no records",
                    },
                  ],
          };
        },
      },
    ],
  };
});

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({
    match: icpMatch,
    reason: icpMatch === null ? "icp classifier unavailable" : icpMatch ? "fits" : "nope",
  }),
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
    receiptId: 1,
  }),
}));

vi.mock("../src/_dedupe.ts", () => ({
  isDuplicate: () => false,
  urlDomain: () => null,
}));

vi.mock("../src/_findemail-prescreen.ts", () => ({ shouldSkipFindEmail: () => ({ ok: true }) }));

let nextEnrichCompanyDomain: string | null = "acme.dev";
let enrichCompanyCalls = 0;
let findEmailCalls = 0;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    enrichCompany: async () => {
      enrichCompanyCalls++;
      return {
        result: {
          status: "ok",
          company: nextEnrichCompanyDomain ? { domain: nextEnrichCompanyDomain } : {},
          cost: 0.005,
        },
        receiptId: 2,
      };
    },
    findEmail: async () => {
      findEmailCalls++;
      return {
        result: { found: true, email: "owner@acme.dev", cost: 0.01 },
        receiptId: 1,
      };
    },
    verifyEmail: async () => ({ result: { deliverable: true, cost: 0.005 }, receiptId: 1 }),
    getLedger: () => ({
      isQueueDuplicate: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runLocalRegistryFinder } = await import("../src/local-registry.ts");

function makeRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    name: "Rae's Taqueria",
    address: "123 Main St",
    city: "Brooklyn",
    state: "NY",
    phone: null,
    matchedDateIso: RECENT_ISO,
    source: "socrata-license",
    sourceLabel: "NYC licenses",
    ...overrides,
  };
}

beforeEach(() => {
  enqueued.length = 0;
  icpMatch = true;
  nextSocrataRecords = [];
  nextNppesRecords = [];
  nextFmcsaRecords = [];
  nextInspectionRecords = [];
  socrataShouldThrow = false;
  nppesShouldThrow = false;
  fmcsaShouldThrow = false;
  inspectionShouldThrow = false;
  nextEnrichCompanyDomain = "acme.dev";
  enrichCompanyCalls = 0;
  findEmailCalls = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runLocalRegistryFinder — routing + isolation", () => {
  it("routes a fresh record to new-business and an old one to free-pilot, each tagged with source + matched date", async () => {
    nextSocrataRecords = [
      makeRecord({ name: "Rae's Taqueria", matchedDateIso: RECENT_ISO }),
      makeRecord({ name: "Old Plumbing Co", matchedDateIso: OLD_ISO, sourceLabel: "NYC licenses" }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "we set it up free",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.candidates).toBe(2);
    expect(out.enqueued).toBe(2);

    const fresh = enqueued.find((r) => r.payload["company"] === "Rae's Taqueria");
    const old = enqueued.find((r) => r.payload["company"] === "Old Plumbing Co");
    expect(fresh?.playName).toBe("new-business");
    expect(old?.playName).toBe("free-pilot");
    expect(fresh?.payload["source"]).toBe("socrata-license");
    expect(fresh?.payload["matchedDateIso"]).toBe(RECENT_ISO);
    expect(fresh?.payload["yourEdge"]).toBe("we set it up free");
  });

  it("keeps candidates from a healthy source when a sibling source throws (one dead source doesn't fail the run)", async () => {
    nextSocrataRecords = [makeRecord()];
    nppesShouldThrow = true;
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
      taxonomies: ["Dentist"],
      states: ["NY"],
    });
    expect(out.enqueued).toBe(1);
    expect(out.halted).toBeUndefined();
  });

  it("halts only when EVERY source returns 0 records", async () => {
    nextSocrataRecords = [];
    nextNppesRecords = [];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.candidates).toBe(0);
    expect(out.enqueued).toBe(0);
    expect(out.halted).toBeTruthy();
  });

  it("enqueues an ICP-rejected row instead of a target when the filter misses", async () => {
    icpMatch = false;
    nextSocrataRecords = [makeRecord()];
    await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.initialStatus).toBe("rejected");
  });

  it("does NOT persist a rejected row when the classifier is transiently unavailable (match=null)", async () => {
    icpMatch = null;
    nextSocrataRecords = [makeRecord()];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(enqueued).toHaveLength(0);
    expect(out.droppedEnrichment).toBe(1);
  });

  it("drops the candidate when enrichCompany resolves no domain", async () => {
    nextEnrichCompanyDomain = null;
    nextSocrataRecords = [makeRecord()];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("dedupes a record surfaced by both sources within the same run", async () => {
    const dup = makeRecord({ name: "Rae's Dental", source: "nppes", sourceLabel: "NPPES Dentist" });
    nextSocrataRecords = [
      makeRecord({ name: "Rae's Dental", source: "nppes", sourceLabel: "NPPES Dentist" }),
    ];
    nextNppesRecords = [dup];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      taxonomies: ["Dentist"],
      states: ["NY"],
    });
    // Both fetch adapters returned the same (source, name, state) record —
    // the finder's within-run dedupe collapses it to one candidate.
    expect(out.candidates).toBe(1);
  });
});

describe("runLocalRegistryFinder — fmcsa knownEmail skip", () => {
  it("enqueues an fmcsa record without calling enrichCompany or findEmail", async () => {
    nextFmcsaRecords = [
      makeRecord({
        name: "Slack Truck Line Inc",
        source: "fmcsa",
        sourceLabel: "FMCSA Company Census",
        knownEmail: "dispatch@slacktruck.com",
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "we help small carriers dispatch smarter",
      entityTypes: ["carrier"],
      states: ["NE"],
    });
    expect(out.enqueued).toBe(1);
    expect(enrichCompanyCalls).toBe(0);
    expect(findEmailCalls).toBe(0);
    expect(enqueued[0]?.payload["email"]).toBe("dispatch@slacktruck.com");
    expect(enqueued[0]?.payload["source"]).toBe("fmcsa");
  });

  it("fmcsa per-candidate cost is at or near zero (no enrichCompany/findEmail spend)", async () => {
    nextFmcsaRecords = [
      makeRecord({
        name: "Slack Truck Line Inc",
        source: "fmcsa",
        sourceLabel: "FMCSA Company Census",
        knownEmail: "dispatch@slacktruck.com",
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      entityTypes: ["carrier"],
      states: ["NE"],
    });
    // verifyEmail still runs (0.005) — findEmail (0.01) and enrichCompany
    // (0.005) are the calls this path is meant to skip.
    expect(out.costUsd).toBeLessThan(0.01);
  });

  it("a socrata-license record (no knownEmail) still goes through enrichCompany + findEmail", async () => {
    nextSocrataRecords = [makeRecord()];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(1);
    expect(enrichCompanyCalls).toBe(1);
    expect(findEmailCalls).toBe(1);
  });
});

describe("runLocalRegistryFinder — socrata-inspection joins the licence lane", () => {
  it("enqueues an inspection-sourced row carrying the establishment + recency but no violation text anywhere in its payload", async () => {
    nextInspectionRecords = [
      makeRecord({
        name: "3M Bar & Grill",
        source: "socrata-inspection",
        sourceLabel: "NYC restaurant inspections",
        matchedDateIso: RECENT_ISO,
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "we help restaurants run tighter ops",
      inspectionPortals: [
        {
          host: "data.cityofnewyork.us",
          dataset: "43nn-pn8j",
          label: "NYC restaurant inspections",
        },
      ],
    });
    expect(out.enqueued).toBe(1);
    const payload = enqueued[0]?.payload;
    expect(payload?.["company"]).toBe("3M Bar & Grill");
    expect(payload?.["matchedDateIso"]).toBe(RECENT_ISO);
    const json = JSON.stringify(payload);
    expect(json).not.toMatch(/violation/i);
    expect(json).not.toMatch(/score/i);
    expect(json).not.toMatch(/lapsed/i);
  });
});
