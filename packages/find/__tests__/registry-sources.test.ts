import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", () => ({ logEvent: () => {} }));

const {
  socrataLicenseSource,
  nppesSource,
  mapSocrataRows,
  mapNppesResults,
  buildSocrataSearchTerm,
} = await import("../src/_registry-sources.ts");

function stubFetch(impl: (url: string) => Promise<unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => impl(url),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const RECENT_ISO = new Date(NOW - 5 * 86_400_000).toISOString();
const OLD_ISO = new Date(NOW - 400 * 86_400_000).toISOString();

describe("buildSocrataSearchTerm", () => {
  it("joins naics + licenseTypes into one $q term", () => {
    expect(buildSocrataSearchTerm(["722511"], ["Food Service"])).toBe("722511 Food Service");
  });
  it("returns null when both are empty/undefined", () => {
    expect(buildSocrataSearchTerm(undefined, undefined)).toBeNull();
    expect(buildSocrataSearchTerm([], [])).toBeNull();
  });
});

describe("mapSocrataRows — canned payload", () => {
  const rows = [
    {
      business_name: "Rae's Taqueria",
      address: "123 Main St",
      city: "Brooklyn",
      state: "NY",
      license_creation_date: RECENT_ISO,
    },
    {
      dba_name: "Old Plumbing Co",
      address: "9 Elm St",
      city: "Queens",
      state: "NY",
      issue_date: OLD_ISO,
    },
    // No usable name field — dropped.
    { address: "1 Nowhere Ave", license_creation_date: RECENT_ISO },
    // No usable date field — dropped.
    { business_name: "No Date Co", address: "2 Elsewhere Ave" },
  ];

  it("maps a recent row inside the freshness window and drops the rest", () => {
    const out = mapSocrataRows(rows, "NYC business licenses", 60);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "Rae's Taqueria",
      address: "123 Main St",
      city: "Brooklyn",
      state: "NY",
      source: "socrata-license",
      sourceLabel: "NYC business licenses",
    });
  });

  it("falls back across alternate name/date field spellings (dba_name, issue_date)", () => {
    const out = mapSocrataRows(rows, "NYC business licenses", 500);
    const names = out.map((r) => r.name).toSorted();
    expect(names).toEqual(["Old Plumbing Co", "Rae's Taqueria"]);
  });
});

describe("socrataLicenseSource.fetch — per-portal isolation", () => {
  it("keeps records from a healthy portal when a sibling portal is dead", async () => {
    stubFetch(async (url) => {
      if (url.includes("dead-portal")) throw new Error("ECONNREFUSED");
      return [
        {
          business_name: "Rae's Taqueria",
          address: "123 Main St",
          city: "Brooklyn",
          state: "NY",
          license_creation_date: RECENT_ISO,
        },
      ];
    });
    const out = await socrataLicenseSource.fetch({
      sinceDays: 60,
      limit: 25,
      portals: [
        { host: "dead-portal.example.com", dataset: "xxxx-xxxx", label: "Dead Portal" },
        { host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" },
      ],
    });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.name).toBe("Rae's Taqueria");
    expect(out.perSource).toHaveLength(2);
    const dead = out.perSource.find((p) => p.label === "Dead Portal");
    const healthy = out.perSource.find((p) => p.label === "NYC licenses");
    expect(dead?.records).toBe(0);
    expect(dead?.error).toBeTruthy();
    expect(healthy?.records).toBe(1);
  });

  it("returns 0 records with per-portal diagnostics when every portal is dead — the caller decides halt", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const out = await socrataLicenseSource.fetch({
      sinceDays: 60,
      limit: 25,
      portals: [{ host: "dead.example.com", dataset: "xxxx-xxxx", label: "Dead" }],
    });
    expect(out.records).toHaveLength(0);
    expect(out.perSource[0]?.error).toBeTruthy();
  });

  it("paginates past the first 200 rows and finds a fresh record living on page 2 — the exact review finding", async () => {
    // Page 1 (offset=0): 200 rows, all OLD — simulates the "arbitrary 200
    // rows" the old unordered $limit=200 call used to settle for, none of
    // which are fresh. Page 2 (offset=200): 1 row, RECENT. Without
    // pagination this recent row is invisible; with $order+$where+$offset
    // it must surface.
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      business_name: `Old Co ${i}`,
      city: "Brooklyn",
      state: "NY",
      license_creation_date: OLD_ISO,
    }));
    const page2 = [
      {
        business_name: "Fresh Taqueria",
        city: "Brooklyn",
        state: "NY",
        license_creation_date: RECENT_ISO,
      },
    ];
    let sawOrder = false;
    let sawWhere = false;
    stubFetch(async (url) => {
      const u = new URL(url);
      if (u.searchParams.get("$limit") === "1") {
        // schema-probe request
        return [page1[0]];
      }
      if (u.searchParams.get("$order")) sawOrder = true;
      if (u.searchParams.get("$where")) sawWhere = true;
      const offset = Number(u.searchParams.get("$offset") ?? "0");
      if (offset === 0) return page1;
      if (offset === 200) return page2;
      return [];
    });
    const out = await socrataLicenseSource.fetch({
      sinceDays: 60,
      limit: 500,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(sawOrder).toBe(true);
    expect(sawWhere).toBe(true);
    const fresh = out.records.find((r) => r.name === "Fresh Taqueria");
    expect(fresh).toBeTruthy();
  });
});

describe("mapNppesResults — canned payload", () => {
  const results = [
    {
      number: "1111111111",
      basic: { organization_name: "Rae's Dental PLLC", enumeration_date: RECENT_ISO },
      addresses: [
        {
          address_purpose: "LOCATION",
          address_1: "50 Health Way",
          city: "Buffalo",
          state: "NY",
          telephone_number: "555-1212",
        },
      ],
    },
    {
      number: "2222222222",
      basic: { first_name: "Pat", last_name: "Lee", enumeration_date: OLD_ISO },
      addresses: [{ address_purpose: "LOCATION", city: "Albany", state: "NY" }],
    },
    // No enumeration_date — dropped.
    { number: "3333333333", basic: { organization_name: "No Date Dental" } },
  ];

  it("maps a recent provider and falls back to first+last name for individuals", () => {
    const out = mapNppesResults(results, "NPPES Dentist (NY)", "NY", 60);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "Rae's Dental PLLC",
      city: "Buffalo",
      state: "NY",
      phone: "555-1212",
      source: "nppes",
    });
  });

  it("uses first+last name when organization_name is absent (individual providers)", () => {
    const out = mapNppesResults(results, "NPPES Dentist (NY)", "NY", 500);
    const names = out.map((r) => r.name).toSorted();
    expect(names).toEqual(["Pat Lee", "Rae's Dental PLLC"]);
  });

  it("labels subjectType organization vs individual so a person's name isn't mistaken for a company", () => {
    const out = mapNppesResults(results, "NPPES Dentist (NY)", "NY", 500);
    const org = out.find((r) => r.name === "Rae's Dental PLLC");
    const individual = out.find((r) => r.name === "Pat Lee");
    expect(org?.subjectType).toBe("organization");
    expect(individual?.subjectType).toBe("individual");
  });
});

describe("nppesSource.fetch — per taxonomy×state isolation", () => {
  it("keeps records from a healthy pair when a sibling pair 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("state=CA")) {
          return {
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result_count: 1,
            results: [
              {
                number: "1111111111",
                basic: { organization_name: "Rae's Dental PLLC", enumeration_date: RECENT_ISO },
                addresses: [{ address_purpose: "LOCATION", city: "Buffalo", state: "NY" }],
              },
            ],
          }),
        };
      }),
    );
    const out = await nppesSource.fetch({
      sinceDays: 60,
      limit: 25,
      taxonomies: ["Dentist"],
      states: ["NY", "CA"],
    });
    expect(out.records).toHaveLength(1);
    expect(out.perSource).toHaveLength(2);
    const bad = out.perSource.find((p) => p.source.endsWith(":CA"));
    const good = out.perSource.find((p) => p.source.endsWith(":NY"));
    expect(bad?.records).toBe(0);
    expect(bad?.error).toBeTruthy();
    expect(good?.records).toBe(1);
  });

  it("returns empty with no perSource entries when taxonomies or states is unconfigured", async () => {
    const out = await nppesSource.fetch({
      sinceDays: 60,
      limit: 25,
      taxonomies: [],
      states: ["NY"],
    });
    expect(out.records).toHaveLength(0);
    expect(out.perSource).toHaveLength(0);
  });

  it("pages past 200 providers (skip) and finds a newly-enumerated one on page 2 — the exact review finding", async () => {
    // Page 1 (skip=0): 200 providers, all OLD — the "arbitrary first 200"
    // the old single-request adapter used to settle for. Page 2 (skip=200):
    // 1 provider, RECENT. Without walking skip, this newly-enumerated
    // provider is invisible and the pair would wrongly report "no providers
    // in the freshness window".
    const page1 = {
      result_count: 200,
      results: Array.from({ length: 200 }, (_, i) => ({
        number: String(1000000000 + i),
        basic: { organization_name: `Old Dental ${i}`, enumeration_date: OLD_ISO },
        addresses: [{ address_purpose: "LOCATION", city: "Buffalo", state: "NY" }],
      })),
    };
    const page2 = {
      result_count: 1,
      results: [
        {
          number: "9999999999",
          basic: { organization_name: "New Dental Group", enumeration_date: RECENT_ISO },
          addresses: [{ address_purpose: "LOCATION", city: "Buffalo", state: "NY" }],
        },
      ],
    };
    let sawSkip200 = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        const skip = Number(u.searchParams.get("skip") ?? "0");
        if (skip === 200) sawSkip200 = true;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => (skip === 0 ? page1 : skip === 200 ? page2 : { results: [] }),
        };
      }),
    );
    const out = await nppesSource.fetch({
      sinceDays: 60,
      limit: 500,
      taxonomies: ["Dentist"],
      states: ["NY"],
    });
    expect(sawSkip200).toBe(true);
    const fresh = out.records.find((r) => r.name === "New Dental Group");
    expect(fresh).toBeTruthy();
  });
});
