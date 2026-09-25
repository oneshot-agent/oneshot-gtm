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
      return { result: { markdown: `page ${url}`, cost: 0.02 } };
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const url = JSON.parse(input.messages[1]!.content).url as string;
      return { content: JSON.stringify(pageExtracts[url] ?? { companies: [] }) };
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
    // A missing domain is looked up by name; a miss stays null (the pipeline drops it).
    expect(byName["Findable"]).toBe("https://findable.io");
    expect(byName["Nowhere"]).toBeNull();
    expect(lookups.toSorted()).toEqual(["Findable", "Nowhere"]);
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
