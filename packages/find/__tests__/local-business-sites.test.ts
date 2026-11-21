import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `local` engine's two opt-in options: `locationsPerRun` (one search per
// location, a cursor walking the list across runs) and `minSites` (only
// domains seen at several addresses, one candidate per domain). Same module
// boundaries mocked as local-business.test.ts: the SDK-safe wrappers, the
// ICP/person filter, enrich, dedupe and the ledger.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
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
interface StubPerson {
  full_name?: string;
  title?: string;
  best_work_email?: string;
  linkedin_url?: string;
}

const enqueued: EnqueuedRow[] = [];
const researchCache = new Map<string, string>();
const knownKeys = new Set<string>();
const localSearchCalls: Array<Record<string, unknown>> = [];
const peopleSearchCalls: Array<Record<string, unknown>> = [];
const findEmailCalls: Array<{ companyDomain?: string | null; fullName?: string }> = [];
const verifyEmailCalls: string[] = [];
/** Places returned for a search, by its one location (or all of them joined). */
let placesFor: (location: string) => StubLocal[] = () => [];
/** Locations whose search fails on the platform. */
let failingLocations = new Set<string>();
let peopleFor: (input: Record<string, unknown>) => StubPerson[] = () => [];
let peopleCost = 0;
/** findEmail fails on the platform (a contact-resolution outage). */
let findEmailFails = false;
const SEARCH_COST = 0.02;

vi.mock("../src/_sdk-safe.ts", () => ({
  safeLocalSearch: async (input: { location: string[] }) => {
    localSearchCalls.push(input as unknown as Record<string, unknown>);
    const key = input.location.join(" | ");
    if (failingLocations.has(key)) {
      return {
        result: { status: "error", results: [], total_found: 0, truncated: false, cost: 0 },
        receiptId: 0,
      };
    }
    const results = placesFor(key);
    return {
      result: {
        status: "ok",
        results,
        total_found: results.length,
        truncated: false,
        cost: SEARCH_COST,
      },
      receiptId: 9,
    };
  },
  safePeopleSearch: async (input: Record<string, unknown>) => {
    peopleSearchCalls.push(input);
    const results = peopleFor(input);
    return {
      result: { status: "ok", results, total_found: results.length, cost: peopleCost },
      receiptId: 1,
    };
  },
  safeCompanySearch: async () => ({
    result: { status: "ok", results: [], total_found: 0, cost: 0 },
    receiptId: 1,
  }),
  safeFindEmail: async (input: { companyDomain?: string | null; fullName?: string }) => {
    findEmailCalls.push(input);
    if (findEmailFails) {
      return { result: { status: "error", found: false, cost: 0 }, receiptId: 0 };
    }
    return {
      result: { found: true, email: `found@${input.companyDomain}`, cost: 0 },
      receiptId: 2,
    };
  },
  safeVerifyEmail: async (input: { email: string }) => {
    verifyEmailCalls.push(input.email);
    return { result: { deliverable: true, cost: 0 }, receiptId: 3 };
  },
}));

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
      isQueueDuplicate: (_play: string, dedupeKey: string) => knownKeys.has(dedupeKey),
      getProductResearchCache: (key: string) => researchCache.get(key) ?? null,
      setProductResearchCache: (key: string, value: string) => {
        researchCache.set(key, value);
      },
      isLinkedInProfileKnown: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { _resetBreaker } = await import("../src/_breaker.ts");
const {
  runLocalBusinessFinder,
  localSearchProgressKey,
  parseLocalCursor,
  parseRememberedSites,
  rotationSlice,
  siteDomain,
  siteKey,
  sitesEvidence,
} = await import("../src/local-business.ts");

const INDUSTRIES = ["hvac contractor"];
const METROS = ["Phoenix, AZ", "Tucson, AZ", "Denver, CO", "Dallas, TX", "Austin, TX"];

function biz(over: StubLocal): StubLocal {
  return {
    id: `id_${over.domain}_${over.address}`,
    name: "Desert Air",
    domain: "desertair.example",
    website: null,
    phone: null,
    category: "hvac contractor",
    address: "1 Main St",
    ...over,
  };
}

const searchedLocations = () =>
  localSearchCalls.map((c) => (c["location"] as string[]).join(" | "));
const cursor = () =>
  JSON.parse(researchCache.get(localSearchProgressKey(INDUSTRIES, METROS)) ?? "null") as {
    next: number;
  } | null;

beforeEach(() => {
  enqueued.length = 0;
  researchCache.clear();
  knownKeys.clear();
  localSearchCalls.length = 0;
  peopleSearchCalls.length = 0;
  findEmailCalls.length = 0;
  verifyEmailCalls.length = 0;
  placesFor = () => [];
  failingLocations = new Set();
  peopleFor = () => [];
  peopleCost = 0;
  findEmailFails = false;
  _resetBreaker();
});
afterEach(() => {
  vi.clearAllMocks();
  _resetBreaker();
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("local engine helpers", () => {
  it("slices the rotation from the cursor and wraps without repeating a location", () => {
    expect(rotationSlice(["a", "b", "c"], 2, 2)).toEqual(["c", "a"]);
    expect(rotationSlice(["a", "b", "c"], 0, 5)).toEqual(["a", "b", "c"]);
  });

  it("reads a saved cursor modulo the list, and anything unreadable as the start", () => {
    expect(parseLocalCursor(JSON.stringify({ next: 4 }), 5)).toBe(4);
    expect(parseLocalCursor(JSON.stringify({ next: 7 }), 5)).toBe(2);
    expect(parseLocalCursor("not json", 5)).toBe(0);
    expect(parseLocalCursor(JSON.stringify({ next: -1 }), 5)).toBe(0);
    expect(parseLocalCursor(null, 5)).toBe(0);
  });

  it("keys the cursor on the category and the location list", () => {
    const key = localSearchProgressKey(INDUSTRIES, METROS);
    expect(key).toMatch(/^local-search-progress:[0-9a-f]{16}$/);
    expect(localSearchProgressKey(INDUSTRIES, [...METROS, "Boise, ID"])).not.toBe(key);
    expect(localSearchProgressKey(["plumber"], METROS)).not.toBe(key);
  });

  it("folds domain case and www., and address case, spacing and punctuation", () => {
    expect(siteDomain(" WWW.DesertAir.Example ")).toBe("desertair.example");
    expect(siteDomain("desertair.example.")).toBe("desertair.example");
    expect(siteKey({ address: "1 Main St., Phoenix", id: "x" })).toBe(
      siteKey({ address: "1 main st phoenix", id: "y" }),
    );
    expect(siteKey({ address: null, id: "abc" })).toBe("id:abc");
    expect(siteKey({ address: null, id: "" })).toBeNull();
  });

  it("names at most three cities in the evidence and counts the rest", () => {
    expect(sitesEvidence(2, ["Austin, TX", "Dallas, TX"])).toBe(
      "2 locations (Austin, TX; Dallas, TX)",
    );
    expect(sitesEvidence(6, ["A", "B", "C", "D", "E"])).toBe("6 locations (A; B; C +2 more)");
  });
});

describe("local engine — locationsPerRun", () => {
  const run = (over: Record<string, unknown> = {}) =>
    runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: INDUSTRIES,
      locations: METROS,
      yourEdge: "x",
      locationsPerRun: 2,
      ...over,
    });

  it("searches each location of the slice alone, saves the cursor, and wraps at the end", async () => {
    await run();
    expect(searchedLocations()).toEqual(["Phoenix, AZ", "Tucson, AZ"]);
    expect(cursor()).toEqual({ next: 2 });

    localSearchCalls.length = 0;
    await run();
    expect(searchedLocations()).toEqual(["Denver, CO", "Dallas, TX"]);
    expect(cursor()).toEqual({ next: 4 });

    localSearchCalls.length = 0;
    await run();
    // Past the last location the rotation starts again at the first.
    expect(searchedLocations()).toEqual(["Austin, TX", "Phoenix, AZ"]);
    expect(cursor()).toEqual({ next: 1 });
  });

  it("names the searched location as the row's city", async () => {
    placesFor = (loc) =>
      loc === "Tucson, AZ" ? [biz({ domain: "cool.example", address: "9 Elm" })] : [];
    peopleFor = () => [{ full_name: "Sam Ortiz", title: "Owner" }];
    const out = await run();
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["city"]).toBe("Tucson, AZ");
  });

  it("leaves the cursor alone on a dry run", async () => {
    await run({ dryRun: true });
    expect(searchedLocations()).toEqual(["Phoenix, AZ", "Tucson, AZ"]);
    expect(cursor()).toBeNull();
  });

  it("stops part-way at the cost cap, and the next run carries on from the next location", async () => {
    const out = await run({ locationsPerRun: 4, maxCostUsd: SEARCH_COST * 2 });
    expect(searchedLocations()).toEqual(["Phoenix, AZ", "Tucson, AZ"]);
    expect(out.halted).toBe(`max-cost cap (${SEARCH_COST * 2})`);
    expect(cursor()).toEqual({ next: 2 });

    localSearchCalls.length = 0;
    await run({ locationsPerRun: 4, maxCostUsd: SEARCH_COST * 2 });
    expect(searchedLocations()).toEqual(["Denver, CO", "Dallas, TX"]);
    expect(cursor()).toEqual({ next: 4 });
  });

  it("skips a failed location, but an outage at the end of the slice is searched again", async () => {
    failingLocations = new Set(["Tucson, AZ", "Dallas, TX"]);
    const out = await run({ locationsPerRun: 4 });
    expect(searchedLocations()).toEqual(["Phoenix, AZ", "Tucson, AZ", "Denver, CO", "Dallas, TX"]);
    // Denver answered after Tucson failed; Dallas failed last.
    expect(cursor()).toEqual({ next: 3 });
    expect(out.halted).toMatch(/no businesses/);
  });

  it("halts on a platform error when every search fails, and keeps the cursor", async () => {
    researchCache.set(localSearchProgressKey(INDUSTRIES, METROS), JSON.stringify({ next: 3 }));
    failingLocations = new Set(METROS);
    const out = await run();
    expect(searchedLocations()).toEqual(["Dallas, TX", "Austin, TX"]);
    expect(out.halted).toMatch(/platform error/);
    expect(cursor()).toEqual({ next: 3 });
  });

  it("unset: one search over every location, with the chain filter, and no cursor", async () => {
    await run({ locationsPerRun: undefined });
    expect(localSearchCalls).toHaveLength(1);
    expect(localSearchCalls[0]).toMatchObject({ location: METROS, isChain: false });
    expect(cursor()).toBeNull();
  });
});

describe("local engine — minSites", () => {
  const run = (over: Record<string, unknown> = {}) =>
    runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: INDUSTRIES,
      locations: METROS,
      yourEdge: "x",
      locationsPerRun: 2,
      minSites: 2,
      ...over,
    });

  it("groups places by domain across the run's searches and queues one row per group", async () => {
    placesFor = (loc) =>
      loc === "Phoenix, AZ"
        ? [
            biz({ domain: "DesertAir.example", address: "1 Main St., Phoenix" }),
            // The same site again, spelled differently: still one site.
            biz({ domain: "desertair.example", address: "1 main st phoenix" }),
            biz({ name: "Solo Cooling", domain: "solo.example", address: "5 Oak" }),
          ]
        : [biz({ domain: "www.desertair.example", address: "77 Speedway, Tucson" })];
    peopleFor = () => [{ full_name: "Dana Reyes", title: "Owner" }];
    const out = await run();

    expect(out.candidates).toBe(4);
    expect(out.enqueued).toBe(1);
    // Below the threshold: an ICP drop, never stored as rejected.
    expect(out.droppedIcp).toBe(1);
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.dedupeKey).toBe("free-pilot:local:desertair.example");
    expect(row.payload).toMatchObject({
      company: "Desert Air",
      siteCount: 2,
      signal: "2 locations (Phoenix, AZ; Tucson, AZ)",
      city: "Phoenix, AZ",
    });
    expect(row.payload).not.toHaveProperty("address");
    // A group is what the index calls a chain: the filter is not sent.
    for (const call of localSearchCalls) expect(call).not.toHaveProperty("isChain");
  });

  it("counts sites seen by an earlier run, so one site per metro still qualifies", async () => {
    placesFor = (loc) =>
      loc === "Phoenix, AZ" ? [biz({ domain: "desertair.example", address: "1 Main" })] : [];
    peopleFor = () => [{ full_name: "Dana Reyes", title: "Owner" }];
    const first = await run();
    expect(first.enqueued).toBe(0);
    expect(first.droppedIcp).toBe(1);

    placesFor = (loc) =>
      loc === "Denver, CO" ? [biz({ domain: "desertair.example", address: "8 Colfax" })] : [];
    const second = await run();
    expect(second.enqueued).toBe(1);
    expect(enqueued[0]!.payload).toMatchObject({
      siteCount: 2,
      signal: "2 locations (Denver, CO; Phoenix, AZ)",
    });
  });

  it("keeps enough remembered sites for a threshold above the default cap", async () => {
    const metros = Array.from({ length: 30 }, (_, i) => `Metro ${i}`);
    placesFor = (loc) => [biz({ domain: "big.example", address: `${loc} 1 Main` })];
    peopleFor = () => [{ full_name: "Dana Reyes", title: "Owner" }];
    for (let i = 0; i < 29; i++) {
      const out = await run({ locations: metros, locationsPerRun: 1, minSites: 30 });
      expect(out.enqueued).toBe(0);
    }
    const stored = JSON.parse(researchCache.get("local-sites:big.example")!) as {
      sites: unknown[];
    };
    expect(stored.sites).toHaveLength(29);
    const last = await run({ locations: metros, locationsPerRun: 1, minSites: 30 });
    expect(last.enqueued).toBe(1);
    expect(enqueued[0]!.payload["siteCount"]).toBe(30);
  });

  it("expires each remembered site on its own, whenever the entry was rewritten", async () => {
    const now = Date.now();
    researchCache.set(
      "local-sites:desertair.example",
      JSON.stringify({
        sites: [
          { key: "addr:old", location: "Tucson, AZ", seenAt: now - 91 * DAY_MS },
          { key: "addr:recent", location: "Denver, CO", seenAt: now - DAY_MS },
        ],
      }),
    );
    expect(
      parseRememberedSites(researchCache.get("local-sites:desertair.example")!, now).map(
        (s) => s.key,
      ),
    ).toEqual(["addr:recent"]);
    placesFor = (loc) =>
      loc === "Phoenix, AZ" ? [biz({ domain: "desertair.example", address: "1 Main" })] : [];
    peopleFor = () => [{ full_name: "Dana Reyes", title: "Owner" }];
    // The 91-day-old site does not count: two sites, not three.
    const out = await run({ minSites: 3 });
    expect(out.enqueued).toBe(0);
    const stored = JSON.parse(researchCache.get("local-sites:desertair.example")!) as {
      sites: Array<{ key: string; seenAt: number }>;
    };
    expect(stored.sites.map((s) => s.key)).toEqual(["addr:1main", "addr:recent"]);
    // The recent site keeps its own time; the one seen now gets now.
    expect(stored.sites[1]!.seenAt).toBe(now - DAY_MS);
    expect(stored.sites[0]!.seenAt).toBeGreaterThanOrEqual(now);
  });

  it("does not remember sites on a dry run", async () => {
    placesFor = () => [biz({ domain: "desertair.example", address: "1 Main" })];
    await run({ dryRun: true });
    expect([...researchCache.keys()].some((k) => k.startsWith("local-sites:"))).toBe(false);
  });

  it("works the biggest groups first when the limit is short", async () => {
    placesFor = () => [
      biz({ name: "Two Sites", domain: "two.example", address: "1 A" }),
      biz({ name: "Two Sites", domain: "two.example", address: "2 A" }),
      biz({ name: "Three Sites", domain: "three.example", address: "1 B" }),
      biz({ name: "Three Sites", domain: "three.example", address: "2 B" }),
      biz({ name: "Three Sites", domain: "three.example", address: "3 B" }),
    ];
    peopleFor = () => [{ full_name: "Dana Reyes", title: "Owner" }];
    const out = await run({ locationsPerRun: 1, limit: 1 });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["company"]).toBe("Three Sites");
  });

  it("works without locationsPerRun: the one search's places are grouped", async () => {
    placesFor = () => [
      biz({ domain: "desertair.example", address: "1 Main" }),
      biz({ domain: "desertair.example", address: "2 Main" }),
    ];
    peopleFor = () => [{ full_name: "Dana Reyes", title: "Owner" }];
    const out = await run({ locationsPerRun: undefined });
    expect(localSearchCalls).toHaveLength(1);
    expect(out.enqueued).toBe(1);
    // Without a rotation the row's city is the first location, as before.
    expect(enqueued[0]!.payload["signal"]).toBe("2 locations (Phoenix, AZ)");
  });
});

describe("local engine — design-partner-loi with jobTitles", () => {
  const run = (over: Record<string, unknown> = {}) =>
    runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: INDUSTRIES,
      locations: ["Phoenix, AZ"],
      yourEdge: "x",
      play: "design-partner-loi",
      buyerType: "enterprise",
      jobTitles: ["Director of Operations", "COO", "Owner"],
      minSites: 2,
      ...over,
    });

  beforeEach(() => {
    placesFor = () => [
      biz({ domain: "desertair.example", address: "1 Main" }),
      biz({ domain: "desertair.example", address: "2 Main" }),
    ];
  });

  it("looks the titles up at the group's domain, two per search, and queues the match", async () => {
    peopleFor = (input) => {
      const titles = input["jobTitles"] as string[] | undefined;
      // The first two titles find no one; the third does.
      if (titles?.includes("Owner")) {
        return [
          { full_name: "Front Desk", title: "Receptionist" },
          { full_name: "Robin Hale", title: "Owner", best_work_email: "robin@desertair.example" },
        ];
      }
      return [];
    };
    const out = await run();
    expect(peopleSearchCalls.map((c) => c["jobTitles"])).toEqual([
      ["Director of Operations", "COO"],
      ["Owner"],
    ]);
    for (const call of peopleSearchCalls) {
      expect(call["companyDomains"]).toEqual(["desertair.example"]);
    }
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("design-partner-loi");
    expect(row.payload).toMatchObject({
      name: "Robin Hale",
      email: "robin@desertair.example",
      company: "Desert Air",
      buyerType: "enterprise",
      siteCount: 2,
      signal: "2 locations (Phoenix, AZ)",
    });
    // The search carried a work email: no findEmail.
    expect(findEmailCalls).toHaveLength(0);
    expect(verifyEmailCalls).toEqual(["robin@desertair.example"]);
  });

  it("finds the email of a titled person with none on file by name", async () => {
    peopleFor = (input) =>
      input["jobTitles"] ? [{ full_name: "Robin Hale", title: "Director of Operations" }] : [];
    await run();
    expect(findEmailCalls).toEqual([
      { companyDomain: "desertair.example", fullName: "Robin Hale" },
    ]);
    expect(enqueued[0]!.payload["name"]).toBe("Robin Hale");
  });

  it("falls back to the domain-only contact when no one has a wanted title", async () => {
    peopleFor = (input) =>
      input["jobTitles"]
        ? [{ full_name: "Front Desk", title: "Receptionist" }]
        : [{ full_name: "Pat Lin", title: "Owner" }];
    const out = await run();
    // Two titled searches, then the domain-only lookup without titles.
    expect(peopleSearchCalls).toHaveLength(3);
    expect(peopleSearchCalls[2]).toEqual({ companyDomains: ["desertair.example"], limit: 10 });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload).toMatchObject({
      name: "Pat Lin",
      email: "found@desertair.example",
    });
  });

  it("stops paid title searches at the cost cap and skips the domain-only lookup", async () => {
    peopleCost = 0.02;
    peopleFor = () => [{ full_name: "Front Desk", title: "Receptionist" }];
    // The places search costs 0.02, so 0.01 is left: one title search, then the cap.
    const out = await run({ maxCostUsd: 0.03 });
    expect(peopleSearchCalls.map((c) => c["jobTitles"])).toEqual([
      ["Director of Operations", "COO"],
    ]);
    expect(findEmailCalls).toHaveLength(0);
    expect(out.enqueued).toBe(0);
    expect(out.halted).toBe("max-cost cap (0.03)");
  });

  it("title searches that answer do not keep the breaker shut through a contact outage", async () => {
    placesFor = () =>
      Array.from({ length: 8 }, (_, i) =>
        biz({ name: `Group ${i}`, domain: `g${i}.example`, address: `${i} Main` }),
      );
    peopleFor = (input) =>
      input["jobTitles"] ? [{ full_name: "Robin Hale", title: "Director of Operations" }] : [];
    findEmailFails = true;
    const out = await run({ minSites: 1 });
    // Five contact failures in a row open the breaker; the other three make no call.
    expect(findEmailCalls).toHaveLength(5);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(8);
  });

  it("without the route, jobTitles are not looked up: the domain-only path as before", async () => {
    peopleFor = () => [{ full_name: "Pat Lin", title: "Owner" }];
    await run({ play: undefined, buyerType: undefined });
    for (const call of peopleSearchCalls) expect(call).not.toHaveProperty("jobTitles");
    expect(enqueued[0]!.playName).toBe("free-pilot");
  });
});
