import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searches: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    webSearch: async ({ query }: { query: string }) => {
      searches.push(query);
      return { result: { cost: 0.01, results: [] } };
    },
    webRead: async () => ({ result: { markdown: "", cost: 0.02 } }),
  };
});

const { _resetStructuredCache, fetchStructuredCohort, parseWebflowPage, scriptBody, valuesAt } =
  await import("../src/_accelerator-structured.ts");
const { getAccelerator } = await import("../src/_accelerators.ts");
const { fetchAcceleratorSearch, mergeRecords } =
  await import("../src/_accelerator-search-adapter.ts");

const FIX = join(import.meta.dirname, "fixtures", "accelerators");
const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");

/** Serve saved page samples by URL; anything else is a 404. */
function servePages(pages: Record<string, string>) {
  const fetched: string[] = [];
  const impl = async (url: string) => {
    fetched.push(url);
    const body = pages[url];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  };
  return { impl, fetched };
}

function rec(name: string, website: string | null, source: "listing" | "websearch") {
  return {
    name,
    website,
    oneLiner: null,
    longDescription: null,
    industry: null,
    tags: [],
    ycUrl: null,
    founderName: null,
    founderLinkedinUrl: null,
    founderPhone: null,
    source,
  };
}

function source(id: string) {
  const s = getAccelerator(id)?.structured;
  if (!s) throw new Error(`${id} has no structured source`);
  return s;
}

const SPEEDRUN_LIST =
  "https://speedrun-api.a16z.com/api/companies/companies/?limit=96&offset=0&ordering=name";
const SPEEDRUN_PAGES = {
  [SPEEDRUN_LIST]: fixture("speedrun-page1.json"),
  "https://speedrun-api.a16z.com/api/companies/companies/?limit=2&offset=2&ordering=name":
    fixture("speedrun-page2.json"),
  [`https://speedrun-api.a16z.com/api/companies/companies/${(JSON.parse(fixture("speedrun-detail.json")) as { id: string }).id}/`]:
    fixture("speedrun-detail.json"),
};

beforeEach(() => {
  _resetStructuredCache();
  searches.length = 0;
});

describe("valuesAt", () => {
  it("walks dot paths and fans out over arrays", () => {
    const o = { a: { b: [{ c: 1 }, { c: 2 }, {}] } };
    expect(valuesAt(o, "a.b[].c")).toEqual([1, 2]);
    expect(valuesAt([1, 2], "")).toEqual([[1, 2]]);
    expect(valuesAt(o, "a.x.y")).toEqual([]);
  });
});

describe("scriptBody", () => {
  it("returns the body of a script by id", () => {
    expect(scriptBody('<p>x</p><script type="application/json" id="d">[1]</script>', "d")).toBe(
      "[1]",
    );
    expect(scriptBody("<p>no script</p>", "d")).toBeNull();
  });
});

describe("structured sources, from saved page samples", () => {
  it("SPC: keeps only companies founded in the target year", async () => {
    const { impl } = servePages({
      "https://www.southparkcommons.com/companies": fixture("spc-companies.html"),
    });
    const r = await fetchStructuredCohort(source("spc"), 2026, 300, impl);
    expect(r.listed).toBe(4);
    expect(r.items.map((i) => i.year)).toEqual([2026, 2026]);
    expect(r.items[0]!.oneLiner).toBeTruthy();
  });

  it("500 Global: dates a company by its earliest investment, with site and founder", async () => {
    const { impl } = servePages({ "https://500.co/api/startups": fixture("500-startups.json") });
    const r = await fetchStructuredCohort(source("500-global"), 2026, 300, impl);
    expect(r.items.map((i) => i.name).toSorted()).toEqual(["Amity Robotics PTE.LTD", "Branddu"]);
    expect(r.items.every((i) => i.website?.startsWith("https://"))).toBe(true);
    const r25 = await fetchStructuredCohort(source("500-global"), 2025, 300, impl);
    expect(r25.items.map((i) => i.name)).toEqual(["Adsmom Inc.,"]);
  });

  it("a16z speedrun: numbered cohorts map to years, pages follow `next`, details fill the site", async () => {
    const { impl, fetched } = servePages(SPEEDRUN_PAGES);
    const r = await fetchStructuredCohort(source("a16z-speedrun"), 2026, 300, impl);
    // SR006 and SR007 are 2026; SR005 is 2025 and SR003 2024.
    expect(r.items.map((i) => i.name).toSorted()).toEqual(["Abliteration.ai", "Acceler8"]);
    expect(r.listed).toBe(4);
    const abl = r.items.find((i) => i.name === "Abliteration.ai")!;
    expect(abl.website).toBe("https://abliteration.ai");
    expect(abl.founderName).toBeTruthy();
    expect(abl.founderLinkedinUrl).toContain("linkedin.com");
    // Acceler8's detail is not served: it keeps what the list gave.
    expect(r.items.find((i) => i.name === "Acceler8")!.website).toBeNull();
    expect(fetched.filter((u) => u.includes("offset=")).length).toBe(2);
    const r25 = await fetchStructuredCohort(source("a16z-speedrun"), 2025, 300, impl);
    expect(r25.items.map((i) => i.name)).toEqual(["Agent Astra"]);
  });

  it("Antler: reads every Webflow list page and skips the filter checkboxes", async () => {
    const { impl, fetched } = servePages({
      "https://www.antler.co/portfolio": fixture("antler-page1.html"),
      "https://www.antler.co/portfolio?0b933bfd_page=2": fixture("antler-page2.html"),
    });
    const r = await fetchStructuredCohort(source("antler"), 2026, 300, impl);
    expect(fetched).toHaveLength(2);
    expect(r.listed).toBe(4);
    expect(r.items.map((i) => [i.name, i.website])).toEqual([
      ["3Square", "https://www.3square.ai"],
      ["AirShelf", "https://airshelf.ai/"],
    ]);
    expect(r.items[0]!.oneLiner).toBe("The Decision OS for the AI era.");
  });

  it("parseWebflowPage reports no next page on the last page", () => {
    const p = parseWebflowPage(
      fixture("antler-page2.html"),
      "https://www.antler.co/portfolio?0b933bfd_page=2",
      { name: "name", year: "year" },
    );
    expect(p.next).toBeNull();
    expect(p.items).toHaveLength(2);
  });

  it("treats a listing with names but no dates as a shape failure, and does not cache it", async () => {
    const undated = fixture("spc-companies.html").replace(/"founded":\s*"\d{4}",/g, "");
    const pages = { "https://www.southparkcommons.com/companies": undated };
    await expect(
      fetchStructuredCohort(source("spc"), 2026, 300, servePages(pages).impl),
    ).rejects.toThrow(/no dated companies/);
    // The next read sees the fixed page, not a cached empty result.
    pages["https://www.southparkcommons.com/companies"] = fixture("spc-companies.html");
    const r = await fetchStructuredCohort(source("spc"), 2026, 300, servePages(pages).impl);
    expect(r.items).toHaveLength(2);
  });

  it("throws when the source has changed shape, so the caller can search instead", async () => {
    const { impl } = servePages({
      "https://www.southparkcommons.com/companies": "<html>redesigned</html>",
    });
    await expect(fetchStructuredCohort(source("spc"), 2026, 300, impl)).rejects.toThrow();
  });
});

describe("fetchAcceleratorSearch with a structured source", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const stubFetch = (pages: Record<string, string>) => {
    globalThis.fetch = servePages(pages).impl as unknown as typeof fetch;
  };

  it("returns the listing's companies for the year, with no paid search", async () => {
    stubFetch(SPEEDRUN_PAGES);
    const acc = getAccelerator("a16z-speedrun")!;
    const r = await fetchAcceleratorSearch("a16z-speedrun-2026", "a16z speedrun 2026", 40, {
      acceleratorName: acc.name,
      year: 2026,
      structured: acc.structured!,
    });
    expect(searches).toEqual([]);
    expect(r.costUsd).toBe(0);
    expect(r.records.map((x) => x.source)).toEqual(["listing", "listing"]);
    expect(r.records.find((x) => x.name === "Abliteration.ai")!.website).toBe(
      "https://abliteration.ai",
    );
  });

  it("an empty year is final: says so, without searching", async () => {
    stubFetch(SPEEDRUN_PAGES);
    const acc = getAccelerator("a16z-speedrun")!;
    const r = await fetchAcceleratorSearch("a16z-speedrun-2027", "a16z speedrun 2027", 40, {
      acceleratorName: acc.name,
      year: 2027,
      structured: acc.structured!,
    });
    expect(r.records).toEqual([]);
    expect(searches).toEqual([]);
    expect(r.diagnostic).toBe("a16z speedrun's listing (4 companies) has none dated 2027");
  });

  it("falls back to search when the listing fails, and says why", async () => {
    stubFetch({});
    const acc = getAccelerator("spc")!;
    const r = await fetchAcceleratorSearch("spc-2026", "South Park Commons 2026", 40, {
      acceleratorName: acc.name,
      year: 2026,
      structured: acc.structured!,
    });
    expect(searches.length).toBeGreaterThan(0);
    expect(r.diagnostic).toMatch(/^South Park Commons's dated listing failed \(HTTP 404/);
  });

  it("a non-authoritative listing (SPC's founding year) keeps its companies and still searches", async () => {
    stubFetch({ "https://www.southparkcommons.com/companies": fixture("spc-companies.html") });
    const acc = getAccelerator("spc")!;
    expect(acc.structured).toMatchObject({ authoritative: false });
    const r = await fetchAcceleratorSearch("spc-2026", "South Park Commons 2026", 40, {
      acceleratorName: acc.name,
      year: 2026,
      structured: acc.structured!,
    });
    expect(searches.length).toBeGreaterThan(0);
    expect(r.records).toHaveLength(2);
    expect(r.records.every((x) => x.source === "listing")).toBe(true);
    expect(r.diagnostic).toBeNull();
  });

  it("mergeRecords adds search records not already listed, by domain or name", () => {
    const merged = mergeRecords(
      [rec("Preseen", null, "listing"), rec("Mesa", "https://mesa.dev", "listing")],
      [
        rec("PRESEEN", "https://preseen.ai", "websearch"),
        rec("Mesa Inc", "https://www.mesa.dev/", "websearch"),
        rec("Fresh", "https://fresh.io", "websearch"),
      ],
    );
    expect(merged.map((m) => m.name)).toEqual(["Preseen", "Mesa", "Fresh"]);
  });

  it("an accelerator with no dated source says so when search finds nothing", async () => {
    const acc = getAccelerator("neo")!;
    expect(acc.structured).toBeNull();
    const r = await fetchAcceleratorSearch("neo-2026", "Neo 2026", 40, {
      acceleratorName: acc.name,
      year: 2026,
      structured: null,
    });
    expect(r.records).toEqual([]);
    expect(r.diagnostic).toMatch(/^no dated source for Neo; /);
  });
});
