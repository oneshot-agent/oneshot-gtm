import { beforeEach, describe, expect, it, vi } from "vitest";

const reads: string[] = [];
const lookups: string[] = [];
let pageExtracts: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    webSearch: async () => ({
      result: {
        cost: 0.01,
        results: Array.from({ length: 12 }, (_, i) => ({
          url: `https://news.example/p${i}`,
          title: `t${i}`,
          description: "",
        })),
      },
    }),
    webRead: async ({ url }: { url: string }) => {
      reads.push(url);
      const markdown = url.includes("long")
        ? `Class of 2026\n${"x".repeat(60_000)}`
        : url.includes("news") || url.includes("class")
          ? `Demo day 2026 at ${url}`
          : `page ${url}`;
      return { result: { markdown, cost: 0.02 } };
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const body = JSON.parse(input.messages[1]!.content) as { url: string; part?: string };
      const key = body.part ? `${body.url}#${body.part}` : body.url;
      return { content: JSON.stringify(pageExtracts[key] ?? { companies: [] }) };
    },
  };
});
vi.mock("../src/_sdk-safe.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_sdk-safe.ts")>("../src/_sdk-safe.ts");
  return {
    ...actual,
    safeCompanySearch: async (input: { name: string }) => {
      lookups.push(input.name);
      return {
        result: {
          cost: 0.01,
          results: input.name === "Findable" ? [{ domain: "findable.io" }] : [],
        },
      };
    },
  };
});

const { fetchAcceleratorSearch, MAX_PAGES_PER_COHORT, inTargetCohort } =
  await import("../src/_accelerator-search-adapter.ts");

beforeEach(() => {
  reads.length = 0;
  lookups.length = 0;
  pageExtracts = {};
});

describe("fetchAcceleratorSearch (multi-company)", () => {
  it("extracts every company of the target year, reading the listing page first", async () => {
    pageExtracts = {
      "https://acc.example/portfolio": {
        aboutTargetCohort: false,
        companies: [
          { name: "Alpha", domain: "alpha.dev", cohort: "2026" },
          { name: "Old Co", domain: "old.co", cohort: "2023" },
          { name: "Unlabelled", domain: "u.co", cohort: null },
        ],
      },
      "https://news.example/p0": {
        aboutTargetCohort: true,
        companies: [
          { name: "Beta", domain: "https://www.beta.ai/about", cohort: null },
          { name: "Findable", domain: null, cohort: null },
          { name: "Nowhere", domain: null, cohort: null },
        ],
      },
    };
    const out = await fetchAcceleratorSearch("acc-2026", "Acc 2026", 25, {
      acceleratorName: "Acc",
      year: 2026,
      listingUrls: ["https://acc.example/portfolio"],
    });
    expect(reads[0]).toBe("https://acc.example/portfolio");
    expect(reads.length).toBeLessThanOrEqual(MAX_PAGES_PER_COHORT);
    const byName = Object.fromEntries(out.records.map((r) => [r.name, r.website]));
    // Off-year and unlabelled rows on an all-years index are dropped.
    expect(Object.keys(byName).toSorted()).toEqual(["Alpha", "Beta", "Findable", "Nowhere"]);
    expect(byName["Beta"]).toBe("https://beta.ai");
    // Domain-less rows stay null here; the pipeline looks them up only after the ICP gate.
    expect(byName["Findable"]).toBeNull();
    expect(lookups).toEqual([]);
  });

  it("extracts a long page in parts, carrying the cohort heading from part 1", async () => {
    pageExtracts = {
      "https://long.example/class#1 of 3": {
        aboutTargetCohort: true,
        companies: [{ name: "First", domain: "first.dev", cohort: null }],
      },
      "https://long.example/class#3 of 3": {
        aboutTargetCohort: false,
        companies: [{ name: "Last", domain: "last.dev", cohort: null }],
      },
    };
    const out = await fetchAcceleratorSearch("acc-2026", "Acc 2026", 25, {
      year: 2026,
      listingUrls: ["https://long.example/class"],
    });
    expect(out.records.map((r) => r.name)).toEqual(["First", "Last"]);
  });

  it("ignores a page the model calls on-cohort when the page never names the year", async () => {
    pageExtracts = {
      "https://acc.example/alumni": {
        aboutTargetCohort: true,
        companies: [{ name: "Famous Alum", domain: "famous.co", cohort: null }],
      },
    };
    const out = await fetchAcceleratorSearch("acc-2026", "Acc 2026", 25, {
      year: 2026,
      listingUrls: ["https://acc.example/alumni"],
    });
    expect(out.records).toEqual([]);
  });

  it("reports pages read when nothing matches", async () => {
    const out = await fetchAcceleratorSearch("acc-2026", "Acc 2026", 25, { year: 2026 });
    expect(out.records).toEqual([]);
    expect(out.diagnostic).toBe(`${MAX_PAGES_PER_COHORT} pages read, no Acc 2026 companies found`);
  });
});

describe("inTargetCohort", () => {
  it("matches the year, and trusts an unlabelled row only on a target-cohort page", () => {
    expect(inTargetCohort({ cohort: "Spring 2026" }, false, { year: 2026, label: "X" })).toBe(true);
    expect(inTargetCohort({ cohort: "2025" }, true, { year: 2026, label: "X" })).toBe(false);
    expect(inTargetCohort({ cohort: null }, true, { year: 2026, label: "X" })).toBe(true);
    expect(inTargetCohort({ cohort: null }, false, { year: 2026, label: "X" })).toBe(false);
  });
});
