import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dedupeKeyFor,
  routePlayFor,
  businessTypeFor,
  issuedAgoLabel,
  licenseTypeFor,
} from "../src/local-registry.ts";
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

  it("is the SAME across sources for the same name/state/city — cross-source dedup is the point (a business licensed AND NPI-enumerated must collapse to one candidate)", () => {
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
    expect(dedupeKeyFor(base)).toBe(dedupeKeyFor({ ...base, source: "nppes" }));
  });

  it("preserves non-ASCII business names instead of stripping them to an empty slug (finding PRRT_kwDOSKzrBs6ewn0O)", () => {
    const a: RegistryRecord = {
      name: "北京饭店",
      address: null,
      city: "Flushing",
      state: "NY",
      phone: null,
      matchedDateIso: "2026-06-01T00:00:00Z",
      source: "socrata-license",
      sourceLabel: "x",
    };
    const b: RegistryRecord = { ...a, name: "上海小吃" };
    // Distinct non-ASCII names must produce distinct keys — the old
    // `[^a-z0-9-]` slug stripped every character of both names to "",
    // colliding them into one dedupe key.
    expect(dedupeKeyFor(a)).not.toBe(dedupeKeyFor(b));
  });

  it("distinguishes same-name businesses in different cities when state is absent (finding PRRT_kwDOSKzrBs6ewn0O)", () => {
    const a: RegistryRecord = {
      name: "Main Street Cafe",
      address: null,
      city: "Springfield",
      state: null,
      phone: null,
      matchedDateIso: "2026-06-01T00:00:00Z",
      source: "socrata-license",
      sourceLabel: "x",
    };
    const b: RegistryRecord = { ...a, city: "Riverside" };
    expect(dedupeKeyFor(a)).not.toBe(dedupeKeyFor(b));
  });

  it("distinguishes 'A&B Plumbing' from 'AB Plumbing' — punctuation must not be stripped without a separator", () => {
    // finding: slugify's old `[^a-z0-9-]` strip (with no replacement)
    // collapsed "A&B Plumbing" and "AB Plumbing" to the identical
    // "ab-plumbing" slug in the same source/state, silently dropping one
    // record as a duplicate of the other.
    const a: RegistryRecord = {
      name: "A&B Plumbing",
      address: null,
      city: null,
      state: "NY",
      phone: null,
      matchedDateIso: "2026-06-01T00:00:00Z",
      source: "socrata-license",
      sourceLabel: "x",
    };
    const b: RegistryRecord = { ...a, name: "AB Plumbing" };
    expect(dedupeKeyFor(a)).not.toBe(dedupeKeyFor(b));
  });

  it("collapses apostrophe-bearing name variants to the SAME key (round 2 correction: #500)", () => {
    // finding: the ampersand fix (round 1, commit 2388ac8) collapsed EVERY
    // punctuation run — apostrophes included — to a hyphen separator, so
    // "Joe's Pizza" (-> "joe-s-pizza") and "Joes Pizza" (-> "joes-pizza")
    // stopped colliding even though the OLD slugify deduped them. Apostrophes
    // must be stripped WITHOUT a separator so possessive-spelling variants
    // across sources still dedupe (same-run AND cross-run ledger checks key
    // off this slug).
    const joesApostrophe: RegistryRecord = {
      name: "Joe's Pizza",
      address: null,
      city: null,
      state: "NY",
      phone: null,
      matchedDateIso: "2026-06-01T00:00:00Z",
      source: "socrata-license",
      sourceLabel: "x",
    };
    const joesNoApostrophe: RegistryRecord = { ...joesApostrophe, name: "Joes Pizza" };
    expect(dedupeKeyFor(joesApostrophe)).toBe(dedupeKeyFor(joesNoApostrophe));

    const mcdonaldsApostrophe: RegistryRecord = { ...joesApostrophe, name: "McDonald's" };
    const mcdonaldsNoApostrophe: RegistryRecord = { ...joesApostrophe, name: "McDonalds" };
    expect(dedupeKeyFor(mcdonaldsApostrophe)).toBe(dedupeKeyFor(mcdonaldsNoApostrophe));

    // Still distinct from the ampersand case above — apostrophe-stripping
    // must not regress the punctuation-as-separator fix for OTHER marks.
    const ampersand: RegistryRecord = { ...joesApostrophe, name: "A&B Plumbing" };
    const noAmpersand: RegistryRecord = { ...joesApostrophe, name: "AB Plumbing" };
    expect(dedupeKeyFor(ampersand)).not.toBe(dedupeKeyFor(noAmpersand));
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
    // Freeze the clock so `boundary` and routePlayFor's own `Date.now()` read
    // the identical millisecond — otherwise a 1ms advance between the two
    // reads pushes cutoffMs past Date.parse(boundary) and the `>=` comparison
    // in local-registry.ts routes this record to free-pilot instead,
    // flaking the assertion (finding PRRT_kwDOSKzrBs6fCBc-).
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const boundary = new Date(now - 21 * 86_400_000).toISOString();
      expect(routePlayFor(boundary, 21)).toBe("new-business");
    } finally {
      vi.useRealTimers();
    }
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
let socrataShouldThrow = false;
let nppesShouldThrow = false;
let fmcsaShouldThrow = false;
/** dedupeKeys that isQueueDuplicate reports as already queued. */
let duplicateDedupeKeys: Set<string> = new Set();

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

let nextResolvedDomain: string | null = "acme.dev";
let nextResolvedStatus: "open" | "closed" = "open";
let localResolveCalls: Array<Record<string, unknown>> = [];
let nextClosestMatch: { name: string; domain: string; address: string } | null = null;
let findEmailCalls = 0;
let verifyEmailCalls = 0;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    localResolve: async (input: Record<string, unknown>) => {
      localResolveCalls.push(input);
      const found = nextResolvedDomain !== null;
      return {
        result: {
          status: "ok",
          found,
          confidence: found ? 0.9 : 0,
          result: found
            ? {
                id: "loc_1",
                name: String(input["name"]),
                domain: nextResolvedDomain,
                website: `https://${nextResolvedDomain}`,
                phone: "+1 555 0100",
                operating_status: nextResolvedStatus,
                category: null,
                is_chain: null,
                address: null,
                socials: {},
                review_count: null,
                rating: null,
                latitude: null,
                longitude: null,
              }
            : null,
          candidates_considered: 1,
          ...(nextClosestMatch
            ? {
                closest_match: {
                  id: "loc_c",
                  name: nextClosestMatch.name,
                  domain: nextClosestMatch.domain,
                  website: `https://${nextClosestMatch.domain}`,
                  phone: null,
                  operating_status: "open",
                  category: null,
                  is_chain: null,
                  address: nextClosestMatch.address,
                  socials: {},
                  review_count: null,
                  rating: null,
                  latitude: null,
                  longitude: null,
                },
              }
            : {}),
          cost: 0.005,
        },
        receiptId: 2,
      };
    },
    peopleSearch: async () => ({
      result: {
        status: "ok",
        results: [{ full_name: "Rae Owner", title: "Owner" }],
        total_found: 1,
        cost: 0.01,
      },
      receiptId: 5,
    }),
    findEmail: async () => {
      findEmailCalls++;
      return {
        result: { found: true, email: "owner@acme.dev", cost: 0.01 },
        receiptId: 1,
      };
    },
    verifyEmail: async () => {
      verifyEmailCalls++;
      return { result: { deliverable: true, cost: 0.005 }, receiptId: 1 };
    },
    getLedger: () => ({
      isQueueDuplicate: (_playName: string, dedupeKey: string) =>
        duplicateDedupeKeys.has(dedupeKey),
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runLocalRegistryFinder, pickResolvedBusiness } = await import("../src/local-registry.ts");

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
  socrataShouldThrow = false;
  nppesShouldThrow = false;
  fmcsaShouldThrow = false;
  duplicateDedupeKeys = new Set();
  nextResolvedDomain = "acme.dev";
  nextResolvedStatus = "open";
  localResolveCalls = [];
  nextClosestMatch = null;
  findEmailCalls = 0;
  verifyEmailCalls = 0;
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
    expect(typeof fresh?.payload["fitReason"]).toBe("string"); // #592
    expect(fresh?.payload["fitReasonSource"]).toBe("company-gate");
    expect(fresh?.payload["matchedDateIso"]).toBe(RECENT_ISO);
    expect(fresh?.payload["yourEdge"]).toBe("we set it up free");
    // #498: both plays REQUIRE these, and runEmailPlay drops a row without
    // them before the LLM — every local-registry row used to be dropped.
    expect(fresh?.payload["businessType"]).toBe("newly licensed local business");
    expect(fresh?.payload["licenseType"]).toBe("business licence");
    expect(fresh?.payload["issuedAgo"]).toMatch(/\S/);
    expect(old?.payload["businessType"]).toBe("newly licensed local business");
  });

  it("prefers the registry's own business type / licence description when the row carries one", async () => {
    nextSocrataRecords = [
      makeRecord({
        name: "Rae's Taqueria",
        matchedDateIso: RECENT_ISO,
        businessType: "Retail Food Establishment",
        licenseType: "Retail Food Establishment",
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["businessType"]).toBe("Retail Food Establishment");
    expect(enqueued[0]?.payload["licenseType"]).toBe("Retail Food Establishment");
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

  it("drops the candidate when localResolve finds no match", async () => {
    nextResolvedDomain = null;
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

  it("dedupes a record surfaced by both sources within the same run, even with genuinely different source tags (socrata-license vs nppes)", async () => {
    nextSocrataRecords = [
      makeRecord({ name: "Rae's Dental", source: "socrata-license", sourceLabel: "NYC licenses" }),
    ];
    nextNppesRecords = [
      makeRecord({ name: "Rae's Dental", source: "nppes", sourceLabel: "NPPES Dentist" }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
      taxonomies: ["Dentist"],
      states: ["NY"],
    });
    // Cross-source dedup is the stated intent: a business licensed AND
    // NPI-enumerated must collapse to one candidate, not be double-enriched
    // and potentially double-queued to different plays.
    expect(out.candidates).toBe(1);
    expect(out.enqueued).toBe(1);
  });

  it("keeps the NEWER cross-source duplicate's matchedDateIso so routing isn't decided by source fetch order (finding PRRT_kwDOSKzrBs6ewn0H)", async () => {
    // socrata (fetched first, per REGISTRY_SOURCES order) reports an OLD
    // license; nppes (fetched second) reports a RECENT enumeration for the
    // same business. Keeping "the first one seen" would keep the old date
    // and wrongly route this business to free-pilot instead of new-business.
    nextSocrataRecords = [
      makeRecord({
        name: "Rae's Dental",
        source: "socrata-license",
        sourceLabel: "NYC licenses",
        matchedDateIso: OLD_ISO,
      }),
    ];
    nextNppesRecords = [
      makeRecord({
        name: "Rae's Dental",
        source: "nppes",
        sourceLabel: "NPPES Dentist",
        matchedDateIso: RECENT_ISO,
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
      taxonomies: ["Dentist"],
      states: ["NY"],
    });
    expect(out.candidates).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.playName).toBe("new-business");
    expect(enqueued[0]?.payload["matchedDateIso"]).toBe(RECENT_ISO);
  });

  it("never enqueues more than `limit` even at concurrency > 1 (finding PRRT_kwDOSKzrBs6ewnz7)", async () => {
    // Five distinct fresh candidates, concurrency 3, limit 1 — the exact
    // review-cited repro shape. A check against `result.enqueued` (mutated
    // only after each candidate's async pipeline fully resolves) lets every
    // in-flight worker see 0 < 1 and proceed; a slot reserved synchronously
    // before the pipeline starts must cap this at exactly 1.
    nextSocrataRecords = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ name: `Candidate ${i}`, matchedDateIso: RECENT_ISO }),
    );
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      limit: 1,
      concurrency: 3,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it("releases the reserved slot on a queue-duplicate drop so it doesn't starve fresh candidates behind it (finding PRRT_kwDOSKzrBs6fCBdz)", async () => {
    // A tick with `limit: 1`: the first record is already queued from a
    // prior run (isQueueDuplicate hits, no paid call runs), the second is
    // fresh. Pre-fix, `reserved` stayed at 1 forever after the duplicate and
    // the fresh candidate never got a turn — the run halted having enqueued
    // nothing, even though the whole point of the tick was the fresh one.
    const dup = makeRecord({ name: "Already Queued LLC", matchedDateIso: RECENT_ISO });
    const fresh = makeRecord({ name: "Brand New Co", matchedDateIso: RECENT_ISO });
    duplicateDedupeKeys = new Set([dedupeKeyFor(dup)]);
    nextSocrataRecords = [dup, fresh];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      limit: 1,
      concurrency: 1,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.droppedDuplicate).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.dedupeKey).toBe(dedupeKeyFor(fresh));
  });

  it("sets result.halted (not just the local flag) when the reserved-slot limit is reached", async () => {
    nextSocrataRecords = Array.from({ length: 3 }, (_, i) =>
      makeRecord({ name: `Candidate ${i}`, matchedDateIso: RECENT_ISO }),
    );
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      limit: 1,
      concurrency: 1,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.halted).toMatch(/limit \(1\) reached/);
  });

  it("carries subjectType through to the queued LocalRegistryTarget payload so a /queue reviewer can see it", async () => {
    nextNppesRecords = [
      makeRecord({
        name: "Dr. Rae Kim",
        source: "nppes",
        sourceLabel: "NPPES Dentist",
        subjectType: "individual",
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      taxonomies: ["Dentist"],
      states: ["NY"],
    });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["subjectType"]).toBe("individual");
  });

  it("omits subjectType from the queued payload when the source doesn't set it (socrata records)", async () => {
    nextSocrataRecords = [makeRecord()];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["subjectType"]).toBeUndefined();
  });
});

describe("runLocalRegistryFinder — fmcsa knownEmail skip", () => {
  it("enqueues an fmcsa record without calling localResolve or findEmail", async () => {
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
    expect(localResolveCalls).toHaveLength(0);
    expect(findEmailCalls).toBe(0);
    // fmcsa's knownEmail is USDOT's own on-file contact address — trusted
    // enough to skip verifyEmail too (finding PRRT_kwDOSKzrBs6exPH2), unlike
    // github-stars/luma's knownEmail (a scraped/surfaced address) which still
    // verifies.
    expect(verifyEmailCalls).toBe(0);
    expect(enqueued[0]?.payload["email"]).toBe("dispatch@slacktruck.com");
    expect(enqueued[0]?.payload["source"]).toBe("fmcsa");
  });

  it("fmcsa per-candidate cost is zero (no localResolve/findEmail/verifyEmail spend)", async () => {
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
    // localResolve (0.005), the domain person lookup (0.01), findEmail
    // (0.01) and verifyEmail (0.005) are all skipped for a trusted fmcsa
    // knownEmail candidate.
    expect(out.costUsd).toBe(0);
  });

  it("a socrata-license record (no knownEmail) goes through localResolve + findEmail, forwarding the address the registry gave us", async () => {
    nextSocrataRecords = [makeRecord({ phone: "+1 718 555 0199", postalCode: "11201" })];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(1);
    expect(localResolveCalls).toHaveLength(1);
    // The whole point over the old name-only enrichCompany guess: the
    // locating fields the record already carries go on the call.
    expect(localResolveCalls[0]).toMatchObject({
      name: "Rae's Taqueria",
      address: "123 Main St",
      city: "Brooklyn",
      region: "NY",
      postalCode: "11201",
      phone: "+1 718 555 0199",
    });
    expect(findEmailCalls).toBe(1);
  });

  it("drops a record the index says has closed — a licence row for a shut business is not a prospect", async () => {
    nextResolvedStatus = "closed";
    nextSocrataRecords = [makeRecord()];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(findEmailCalls).toBe(0);
  });

  it("prefers the resolved phone over the registry's when the contact spine returns none", async () => {
    nextSocrataRecords = [makeRecord({ phone: "+1 718 555 0199" })];
    await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(enqueued[0]?.payload["phone"]).toBe("+1 555 0100");
  });
});

describe("runLocalRegistryFinder — mid-turn max-cost recheck", () => {
  it("halts before findEmail when localResolve's own spend already crossed the cap", async () => {
    // finding PRRT_kwDOSKzrBs6exPH4: the top-of-turn cap check ran before
    // the resolution call, so a single candidate could push spend past
    // maxCostUsd (localResolve 0.005) and still enter
    // resolveVerifyEnrichQualify's own paid calls. A cap of exactly the
    // resolve cost pins the fix: the SAME candidate's findEmail must never
    // fire once the recheck sees costUsd >= maxCostUsd.
    nextSocrataRecords = [
      makeRecord({ name: "Rae's Taqueria" }),
      makeRecord({ name: "Sam's Diner" }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      concurrency: 1,
      maxCostUsd: 0.005,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(localResolveCalls).toHaveLength(1);
    expect(findEmailCalls).toBe(0);
    expect(out.enqueued).toBe(0);
    expect(out.halted).toContain("max-cost cap");
  });
});

describe("pickResolvedBusiness — address-confirmed matches below the SDK's name threshold", () => {
  const closest = {
    id: "loc_x",
    name: "Smiles at Telfair Family and Cosmetic Dentistry",
    domain: "smilesattelfair.com",
    website: "https://smilesattelfair.com",
    phone: "+1 832 555 0100",
    operating_status: "open" as const,
    category: "dental practice",
    is_chain: null,
    address: "1227 Museum Square Dr Ste D, Sugar Land, TX 77479",
    socials: {},
    review_count: null,
    rating: null,
    latitude: null,
    longitude: null,
  };

  it("returns the SDK's own match when it cleared the threshold", () => {
    const out = pickResolvedBusiness(
      { address: "1 Elsewhere Rd", postalCode: "00000" },
      { found: true, result: closest },
    );
    expect(out?.domain).toBe("smilesattelfair.com");
  });

  it("accepts closest_match when the street number and 5-digit postal code both agree — the legal-name vs trade-name gap", () => {
    const out = pickResolvedBusiness(
      // NPPES: individual dentist's name, ZIP+4 with no hyphen.
      { address: "1227 MUSEUM SQUARE DR", postalCode: "774794629" },
      { found: false, result: null, closest_match: closest },
    );
    expect(out?.domain).toBe("smilesattelfair.com");
  });

  it("rejects closest_match on a different street number — a same-street neighbour is the wrong business to email", () => {
    const out = pickResolvedBusiness(
      { address: "1229 MUSEUM SQUARE DR", postalCode: "774794629" },
      { found: false, result: null, closest_match: closest },
    );
    expect(out).toBeNull();
  });

  it("rejects closest_match when the postal code disagrees, even with the same street number", () => {
    const out = pickResolvedBusiness(
      { address: "1227 MUSEUM SQUARE DR", postalCode: "770010000" },
      { found: false, result: null, closest_match: closest },
    );
    expect(out).toBeNull();
  });

  it("returns null when the registry row has no usable address or postal code to confirm on", () => {
    expect(
      pickResolvedBusiness(
        { address: null, postalCode: "774794629" },
        { found: false, result: null, closest_match: closest },
      ),
    ).toBeNull();
    expect(
      pickResolvedBusiness(
        { address: "1227 MUSEUM SQUARE DR", postalCode: null },
        { found: false, result: null, closest_match: closest },
      ),
    ).toBeNull();
  });
});

describe("runLocalRegistryFinder — trade name from an address-confirmed match", () => {
  it("writes to the name on the door and keeps the registry's legal name as provenance", async () => {
    nextResolvedDomain = null; // SDK threshold misses …
    nextClosestMatch = {
      name: "Smiles at Telfair Family and Cosmetic Dentistry",
      domain: "smilesattelfair.com",
      address: "1227 Museum Square Dr Ste D, Sugar Land, TX 77479",
    };
    nextSocrataRecords = [
      makeRecord({
        name: "A PROFESSIONAL DENTAL ORGANIZATION",
        address: "1227 MUSEUM SQUARE DR",
        postalCode: "774794629",
        city: "Sugar Land",
        state: "TX",
      }),
    ];
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "x",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["company"]).toBe("Smiles at Telfair Family and Cosmetic Dentistry");
    expect(enqueued[0]?.payload["registryName"]).toBe("A PROFESSIONAL DENTAL ORGANIZATION");
  });
});

describe("issuedAgoLabel / per-source defaults (#498)", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString();
  it("reads like a person would say it", () => {
    expect(issuedAgoLabel(daysAgo(0), now)).toBe("today");
    expect(issuedAgoLabel(daysAgo(1), now)).toBe("yesterday");
    expect(issuedAgoLabel(daysAgo(6), now)).toBe("6 days ago");
    expect(issuedAgoLabel(daysAgo(20), now)).toBe("2 weeks ago");
    expect(issuedAgoLabel(daysAgo(45), now)).toBe("6 weeks ago");
    expect(issuedAgoLabel(daysAgo(60), now)).toBe("2 months ago");
    expect(issuedAgoLabel(daysAgo(100), now)).toBe("3 months ago");
    expect(issuedAgoLabel("not a date", now)).toBe("recently");
  });
  it("falls back per source and never returns an empty string", () => {
    const base = makeRecord({ businessType: "  ", licenseType: null });
    expect(businessTypeFor({ ...base, source: "nppes" })).toBe("healthcare practice");
    expect(licenseTypeFor({ ...base, source: "nppes" })).toBe("NPI enumeration");
    expect(businessTypeFor({ ...base, source: "fmcsa" })).toBe("motor carrier");
    expect(businessTypeFor({ ...base, businessType: "Dentist" })).toBe("Dentist");
  });
});
