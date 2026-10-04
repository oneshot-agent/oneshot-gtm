import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// verifySignal: the company's own evidence for a third-party list's claim.
// Free page fetches first, a search and a read only when they find nothing;
// only a real subprocessor list can say "absent", and a failure is never
// cached.

type Hit = { url: string; title: string; description: string };

const cache = new Map<string, string>();
let pages: Record<string, string> = {};
let fetchThrows = false;
let searchHits: Record<string, Hit[]> = {};
let searchThrows = false;
let searches: string[] = [];
let reads: string[] = [];
let readPages: Record<string, string> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    webSearch: async ({ query }: { query: string }) => {
      searches.push(query);
      if (searchThrows) throw new Error("Tool request failed");
      return { result: { results: searchHits[query] ?? [], cost: 0.002 } };
    },
    webRead: async ({ url }: { url: string }) => {
      reads.push(url);
      return { result: { markdown: readPages[url] ?? "", cost: 0.003 } };
    },
    getLedger: () => ({
      getProductResearchCache: (key: string) => cache.get(key) ?? null,
      setProductResearchCache: (key: string, value: string) => void cache.set(key, value),
    }),
  };
});

const fetchMock = vi.fn(async (url: string) => {
  if (fetchThrows) throw new Error("ECONNRESET");
  const body = pages[url];
  return { ok: body !== undefined, status: body ? 200 : 404, url, text: async () => body ?? "" };
});

const { isSubprocessorList, namesAny, verifySignal } = await import("../src/_signal-verify.ts");

/** A subprocessor list page as a company publishes it. */
const list = (...vendors: string[]) =>
  `<html><body><h1>Subprocessors</h1><table>${[
    "Amazon Web Services",
    "Datadog",
    "Snowflake",
    ...vendors,
  ]
    .map((v) => `<tr><td>${v}</td><td>Hosting</td></tr>`)
    .join("")}</table></body></html>`;

const SUB = { names: ["Browserbase"], via: ["subprocessors" as const] };
const run = (verify: { names: string[]; via: ("subprocessors" | "mentions")[] } = SUB) =>
  verifySignal({ company: "Acme", domain: "acme.example", verify });

beforeEach(() => {
  cache.clear();
  pages = {};
  fetchThrows = false;
  searchHits = {};
  searchThrows = false;
  searches = [];
  reads = [];
  readPages = {};
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("matching", () => {
  it("names match whole words, ignoring case", () => {
    expect(namesAny("We use exa for search", ["Exa"])).toBe(true);
    expect(namesAny("for example only", ["Exa"])).toBe(false);
    expect(namesAny("Open AI, L.L.C.", ["OpenAI", "Open AI"])).toBe(true);
  });

  it("a subprocessor list says so and names the usual processors; a script-built shell does not count", () => {
    expect(isSubprocessorList("Sub-processors: Amazon Web Services, Datadog, Stripe")).toBe(true);
    expect(isSubprocessorList("Subprocessors. Loading…")).toBe(false);
    expect(isSubprocessorList("Amazon Web Services, Datadog, Stripe")).toBe(false);
  });
});

describe("subprocessors", () => {
  it("confirms from a page on the usual path with no paid call", async () => {
    pages["https://acme.example/legal/subprocessors"] = list("Browserbase");
    const out = await run();
    expect(out).toMatchObject({
      verdict: "confirmed",
      url: "https://acme.example/legal/subprocessors",
      via: "subprocessors",
      costUsd: 0,
    });
    expect(searches).toHaveLength(0);
  });

  it("a real list without the vendor is absent; a confirming page elsewhere wins", async () => {
    pages["https://acme.example/subprocessors"] = list("Twilio");
    expect((await run()).verdict).toBe("absent");
    cache.clear();
    pages["https://trust.acme.example"] = list("Browserbase");
    expect(await run()).toMatchObject({ verdict: "confirmed", url: "https://trust.acme.example" });
  });

  it("a script-built shell falls through to search; a snippet naming the vendor confirms with no read", async () => {
    pages["https://acme.example/trust"] = "<div id=root>Subprocessors</div>";
    searchHits['"Acme" subprocessors'] = [
      { url: "https://other.example/acme", title: "Browserbase customers", description: "" },
      {
        url: "https://acme.safebase.io/subprocessors",
        title: "Acme Trust Center",
        description: "Subprocessors: AWS, Browserbase",
      },
    ];
    const out = await run();
    expect(out).toMatchObject({
      verdict: "confirmed",
      url: "https://acme.safebase.io/subprocessors",
    });
    expect(reads).toHaveLength(0);
    expect(out.costUsd).toBeCloseTo(0.002);
  });

  it("reads the first on-domain hit and judges it like a fetched page", async () => {
    const hit = "https://www.acme.example/legal/vendors";
    searchHits['"Acme" subprocessors'] = [{ url: hit, title: "Vendors", description: "" }];
    readPages[hit] = "Sub-processors\n| AWS | Datadog | Stripe | Browserbase |";
    expect(await run()).toMatchObject({ verdict: "confirmed", url: hit });
    expect(reads).toEqual([hit]);

    cache.clear();
    readPages[hit] = "Sub-processors\n| AWS | Datadog | Stripe |";
    expect((await run()).verdict).toBe("absent");
  });

  it("nothing found is unknown, and is cached", async () => {
    const out = await run();
    expect(out.verdict).toBe("unknown");
    expect(cache.size).toBe(1);
    searches = [];
    expect((await run()).verdict).toBe("unknown");
    expect(searches).toHaveLength(0);
  });

  it("a failed search is unknown and not cached, so the next run checks again", async () => {
    searchThrows = true;
    const out = await run();
    expect(out).toMatchObject({ verdict: "unknown", errored: true });
    expect(cache.size).toBe(0);
  });

  it("unreachable pages are not an error", async () => {
    fetchThrows = true;
    expect((await run()).verdict).toBe("unknown");
    expect(cache.size).toBe(1);
  });

  it("a cached verdict costs nothing", async () => {
    pages["https://acme.example/sub-processors"] = list("Browserbase");
    await run();
    fetchMock.mockClear();
    const again = await run();
    expect(again).toMatchObject({ verdict: "confirmed", costUsd: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mentions", () => {
  const MEN = { names: ["Backstage"], via: ["mentions" as const] };

  it("confirms from the company's own site or its own job post; never fetches subprocessor pages", async () => {
    searchHits['"Acme" "Backstage" engineer'] = [
      {
        url: "https://boards.greenhouse.io/other/jobs/1",
        title: "Platform Engineer (Backstage)",
        description: "",
      },
      {
        url: "https://jobs.lever.co/acme/123",
        title: "Acme - Staff Platform Engineer",
        description: "Own our Backstage developer portal",
      },
    ];
    const out = await run(MEN);
    expect(out).toMatchObject({
      verdict: "confirmed",
      url: "https://jobs.lever.co/acme/123",
      via: "mentions",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a mention on the company's own site needs engineering context: the tool name may be an ordinary word", async () => {
    searchHits['"Backstage" site:acme.example'] = [
      {
        url: "https://www.acme.example/Pitlochry-Hotels-Backstage.h9.Hotel-Information",
        title: "Backstage Hotel, Pitlochry",
        description: "Book the Backstage hotel",
      },
      {
        url: "https://acme.example/blog/portal",
        title: "How we run Backstage",
        description: "Our developer portal, five years in",
      },
    ];
    expect(await run(MEN)).toMatchObject({
      verdict: "confirmed",
      url: "https://acme.example/blog/portal",
    });
    searchHits['"Backstage" site:acme.example'] = searchHits[
      '"Backstage" site:acme.example'
    ]!.slice(0, 1);
    cache.clear();
    expect((await run(MEN)).verdict).toBe("unknown");
  });

  it("no mention is unknown, never absent", async () => {
    searchHits['"Backstage" site:acme.example'] = [
      { url: "https://acme.example/blog/portal", title: "Our portal", description: "in-house" },
    ];
    expect((await run(MEN)).verdict).toBe("unknown");
    expect(searches).toEqual(['"Backstage" site:acme.example', '"Acme" "Backstage" engineer']);
  });

  it("runs after subprocessors only when that found nothing", async () => {
    pages["https://acme.example/subprocessors"] = list("Twilio");
    const both = { names: ["Browserbase"], via: ["subprocessors" as const, "mentions" as const] };
    expect((await run(both)).verdict).toBe("absent");
    expect(searches).toHaveLength(0);
  });
});
