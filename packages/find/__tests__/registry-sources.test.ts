import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", () => ({ logEvent: () => {} }));

const {
  socrataLicenseSource,
  nppesSource,
  fmcsaSource,
  socrataInspectionSource,
  mapSocrataRows,
  mapNppesResults,
  mapFmcsaRows,
  mapInspectionRows,
  buildSocrataSearchTerm,
  buildFmcsaWhere,
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
});

describe("buildFmcsaWhere", () => {
  it("always requires an active status + a published email", () => {
    const where = buildFmcsaWhere({ sinceDays: 60, limit: 25 });
    expect(where).toContain("status_code='A'");
    expect(where).toContain("email_address IS NOT NULL");
  });

  it("adds an OR'd carship clause for multiple entity types", () => {
    const where = buildFmcsaWhere({
      sinceDays: 60,
      limit: 25,
      entityTypes: ["carrier", "broker"],
    });
    expect(where).toContain("carship like '%C%'");
    expect(where).toContain("carship like '%B%'");
    expect(where).toContain(" OR ");
  });

  it("adds a phy_state IN clause, uppercased", () => {
    const where = buildFmcsaWhere({ sinceDays: 60, limit: 25, states: ["ny", "ca"] });
    expect(where).toContain("phy_state in('NY','CA')");
  });

  it("adds power-unit floor/ceiling clauses", () => {
    const where = buildFmcsaWhere({
      sinceDays: 60,
      limit: 25,
      minPowerUnits: 10,
      maxPowerUnits: 100,
    });
    expect(where).toContain("power_units::number>=10");
    expect(where).toContain("power_units::number<=100");
  });

  it("filters $where on add_date so the wire query itself is scoped to the freshness window", () => {
    const where = buildFmcsaWhere({ sinceDays: 60, limit: 25 });
    // add_date is a zero-padded YYYYMMDD string column; a lexical >= bound
    // against another zero-padded YYYYMMDD string is a correct freshness
    // filter server-side, so the ~2.2M-row active-carrier table isn't
    // sampled at random relative to `sinceDays` before the local filter runs.
    expect(where).toMatch(/add_date>='\d{8}'/);
    const sinceStr = where.match(/add_date>='(\d{8})'/)?.[1];
    expect(sinceStr).toBeTruthy();
    const expected = new Date(Date.now() - 60 * 86_400_000);
    const expectedStr =
      expected.getUTCFullYear().toString().padStart(4, "0") +
      (expected.getUTCMonth() + 1).toString().padStart(2, "0") +
      expected.getUTCDate().toString().padStart(2, "0");
    expect(sinceStr).toBe(expectedStr);
  });
});

describe("mapFmcsaRows — canned payload", () => {
  const NOW_STR = new Date(NOW).toISOString().slice(0, 10).replace(/-/g, "");
  const OLD_STR = "20200101";
  const rows = [
    {
      legal_name: "Slack Truck Line Inc",
      email_address: "Dispatch@SlackTruck.com",
      add_date: NOW_STR,
      phy_street: "7th and Gibbon Rd",
      phy_city: "Gibbon",
      phy_state: "NE",
      phone: "3083802037",
      power_units: "4",
    },
    // Old registration — dropped by the freshness window.
    {
      legal_name: "Old Hauling Co",
      email_address: "old@hauling.com",
      add_date: OLD_STR,
    },
    // No email on file — dropped (fmcsa never falls through to findEmail).
    { legal_name: "No Email Trucking", add_date: NOW_STR },
    // No usable name — dropped.
    { email_address: "noname@x.com", add_date: NOW_STR },
  ];

  it("maps a recent row with a published email and drops the rest", () => {
    const out = mapFmcsaRows(rows, 5);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "Slack Truck Line Inc",
      knownEmail: "dispatch@slacktruck.com",
      city: "Gibbon",
      state: "NE",
      phone: "3083802037",
      source: "fmcsa",
      sourceLabel: "FMCSA Company Census",
    });
  });

  it("keeps the old row once the freshness window is wide enough", () => {
    const out = mapFmcsaRows(rows, 3000);
    const names = out.map((r) => r.name).toSorted();
    expect(names).toEqual(["Old Hauling Co", "Slack Truck Line Inc"]);
  });
});

describe("fmcsaSource.fetch", () => {
  it("returns records with knownEmail set, costUsd 0", async () => {
    stubFetch(async () => [
      {
        legal_name: "Slack Truck Line Inc",
        email_address: "dispatch@slacktruck.com",
        add_date: new Date(NOW).toISOString().slice(0, 10).replace(/-/g, ""),
        phy_state: "NE",
      },
    ]);
    const out = await fmcsaSource.fetch({ sinceDays: 30, limit: 25 });
    expect(out.costUsd).toBe(0);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.knownEmail).toBe("dispatch@slacktruck.com");
    expect(out.perSource[0]?.records).toBe(1);
  });

  it("surfaces a diagnostic without throwing when the endpoint is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const out = await fmcsaSource.fetch({ sinceDays: 30, limit: 25 });
    expect(out.records).toHaveLength(0);
    expect(out.perSource[0]?.error).toBeTruthy();
  });
});

describe("mapInspectionRows — canned payload, violation-free by construction", () => {
  const rows = [
    {
      dba: "3M Bar & Grill",
      street: "119-15 Liberty Avenue",
      city: "Queens",
      state: "NY",
      phone: "7183743144",
      inspection_date: RECENT_ISO,
      // Violation/score fields present on the RAW row — must NOT survive mapping.
      violation_code: "04L",
      violation_description:
        "Evidence of mice or live mice in establishment's food or non-food areas.",
      critical_flag: "Critical",
      score: "35",
      action: "Violations were cited in the following area(s).",
    },
    // Second, older inspection of the SAME establishment — collapsed by the
    // per-portal (name, state) dedupe to just the row above.
    {
      dba: "3M Bar & Grill",
      state: "NY",
      inspection_date: OLD_ISO,
      violation_code: "02G",
    },
    // No usable name — dropped.
    { inspection_date: RECENT_ISO },
    // No usable date — dropped.
    { dba: "No Date Diner" },
  ];

  it("maps the most recent row per establishment and drops the rest", () => {
    const out = mapInspectionRows(rows, "NYC restaurant inspections", 60);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "3M Bar & Grill",
      address: "119-15 Liberty Avenue",
      city: "Queens",
      state: "NY",
      phone: "7183743144",
      source: "socrata-inspection",
      sourceLabel: "NYC restaurant inspections",
    });
  });

  it("never carries violation/score/action fields onto the mapped record", () => {
    const out = mapInspectionRows(rows, "NYC restaurant inspections", 60);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/violation/i);
    expect(json.toLowerCase()).not.toContain("critical");
    expect(json).not.toContain("35");
    expect(json).not.toMatch(/cited/i);
    // Only the declared RegistryRecord keys are present.
    for (const rec of out) {
      expect(Object.keys(rec).toSorted()).toEqual(
        [
          "address",
          "city",
          "matchedDateIso",
          "name",
          "phone",
          "source",
          "sourceLabel",
          "state",
        ].toSorted(),
      );
    }
  });
});

describe("socrataInspectionSource.fetch — per-portal isolation", () => {
  it("keeps records from a healthy portal when a sibling portal is dead", async () => {
    stubFetch(async (url) => {
      if (url.includes("dead-portal")) throw new Error("ECONNREFUSED");
      return [
        {
          dba: "3M Bar & Grill",
          city: "Queens",
          state: "NY",
          inspection_date: RECENT_ISO,
        },
      ];
    });
    const out = await socrataInspectionSource.fetch({
      sinceDays: 60,
      limit: 25,
      inspectionPortals: [
        { host: "dead-portal.example.com", dataset: "xxxx-xxxx", label: "Dead Portal" },
        { host: "data.cityofnewyork.us", dataset: "43nn-pn8j", label: "NYC inspections" },
      ],
    });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.name).toBe("3M Bar & Grill");
    expect(out.perSource).toHaveLength(2);
    const dead = out.perSource.find((p) => p.label === "Dead Portal");
    const healthy = out.perSource.find((p) => p.label === "NYC inspections");
    expect(dead?.records).toBe(0);
    expect(dead?.error).toBeTruthy();
    expect(healthy?.records).toBe(1);
  });

  it("defaults the $order column to inspection_date when the portal doesn't declare dateField", async () => {
    let seenUrl = "";
    stubFetch(async (url) => {
      seenUrl = url;
      return [];
    });
    await socrataInspectionSource.fetch({
      sinceDays: 60,
      limit: 25,
      inspectionPortals: [
        { host: "data.cityofnewyork.us", dataset: "43nn-pn8j", label: "NYC inspections" },
      ],
    });
    expect(seenUrl).toContain("%24order=inspection_date+DESC");
  });

  it("orders on the portal's declared dateField instead of the default, for alternate schemas", async () => {
    // INSPECTION_DATE_FIELDS documents "date"/"activity_date" as alternates
    // to "inspection_date" for row mapping — the $order clause on the wire
    // has to name whichever column the portal actually has, or Socrata 400s
    // before mapInspectionRows' flexible field fallback ever runs.
    let seenUrl = "";
    stubFetch(async (url) => {
      seenUrl = url;
      return [
        {
          business_name: "Alt Schema Diner",
          state: "CA",
          activity_date: RECENT_ISO,
        },
      ];
    });
    const out = await socrataInspectionSource.fetch({
      sinceDays: 60,
      limit: 25,
      inspectionPortals: [
        {
          host: "data.alt-portal.example.gov",
          dataset: "yyyy-yyyy",
          label: "Alt Portal",
          dateField: "activity_date",
        },
      ],
    });
    expect(seenUrl).toContain("%24order=activity_date+DESC");
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.name).toBe("Alt Schema Diner");
  });
});
