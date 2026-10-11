import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// list-page: a public list of companies in, one design-partner-loi row per
// company out, stamped with what the list means. Every paid step is mocked;
// what's asserted is the order of spend (dedupe first), the payload, and the
// halts.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
}

const enqueued: EnqueuedRow[] = [];
const cache = new Map<string, string>();
let queued = new Set<string>();
let webReads = 0;
let llmCalls = 0;
let llmInputs: string[] = [];
/** The mock model's reply is cut off when a chunk has more lines than this. */
let llmMaxLines: number | null = null;
let contactCalls: Array<Record<string, unknown>> = [];
let contactResult: Record<string, unknown> = {};
let contactByName: Record<string, Record<string, unknown>> = {};
let companySearchDomain: string | null = null;
const roleRejections: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    webRead: async () => {
      webReads++;
      return {
        result: { markdown: "| [Other Co](https://other.example) | | Uses it |", cost: 0.002 },
      };
    },
    getLedger: () => ({
      isQueueDuplicate: (_play: string, key: string) => queued.has(key),
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
      getProductResearchCache: (key: string) => cache.get(key) ?? null,
      setProductResearchCache: (key: string, value: string) => void cache.set(key, value),
    }),
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (args: { messages: Array<{ content: string }> }) => {
      llmCalls++;
      const input = JSON.parse(args.messages[1]!.content) as { markdown: string };
      llmInputs.push(input.markdown);
      if (llmMaxLines !== null && input.markdown.split("\n").length > llmMaxLines) {
        throw new actual.LlmTruncatedError("truncated at max_tokens=4000 (raise maxTokens) — t t.");
      }
      // One company per table row that names one, like the real extraction.
      const companies = [
        ...input.markdown.matchAll(/\| \[([^\]]+)\]\(([^)]+)\) \| ([^|]*)\| ([^|]*)\|/g),
      ].map((m) => ({
        name: m[1],
        website: new URL(m[2]!).hostname === "github.com" ? null : m[2],
        contacts: m[3]!.trim() ? [{ github: m[3]!.trim().replace(/^@/, "") }] : [],
        context: m[4]!.trim() || null,
      }));
      return { content: JSON.stringify({ companies }), provider: "t", model: "t" };
    },
  };
});

vi.mock("../src/_filter.ts", () => ({ resolveIcp: () => "icp" }));

vi.mock("../src/_qualify.ts", () => ({
  persistRoleRejection: (args: Record<string, unknown>) => void roleRejections.push(args),
}));

let peopleSearchCalls: Array<Record<string, unknown>> = [];
let peopleSearchResult: { status?: string; results: Array<Record<string, unknown>> } = {
  results: [],
};
vi.mock("../src/_sdk-safe.ts", () => ({
  safeCompanySearch: async () => ({
    result: { cost: 0.01, results: companySearchDomain ? [{ domain: companySearchDomain }] : [] },
  }),
  safePeopleSearch: async (input: Record<string, unknown>) => {
    peopleSearchCalls.push(input);
    return { result: { cost: 0.01, ...peopleSearchResult } };
  },
}));

vi.mock("../src/_contact.ts", () => ({
  resolveVerifyEnrichQualify: async (args: Record<string, unknown>) => {
    contactCalls.push(args);
    const byName = contactByName[args["fullName"] as string];
    return byName ?? contactResult;
  },
  icpFields: () => ({ icpVerdict: "pass", icpVerdictReason: "owns AI platform" }),
}));

let verifyCalls: Array<Record<string, unknown>> = [];
let verifyResult: Record<string, unknown> = { verdict: "unknown", costUsd: 0 };
vi.mock("../src/_signal-verify.ts", () => ({
  verifySignal: async (args: Record<string, unknown>) => {
    verifyCalls.push(args);
    return verifyResult;
  },
}));

const ADOPTERS = [
  "# Adopters",
  "",
  "| Organization | Contact | Description of Use |",
  "|---|---|---|",
  "| [Acme](https://www.acme.example) | @ada | Developer portal for every team |",
  "| [Beta Corp](https://github.com/beta) | @bob | Unifying internal tooling |",
  "| [Gamma](https://gamma.example/about) |  | Service catalog |",
].join("\n");

const defaultFetch = async (url: string) => ({
  ok: true,
  status: 200,
  text: async () => (url.startsWith("https://raw.githubusercontent.com/") ? ADOPTERS : ""),
});
const fetchMock = vi.fn(defaultFetch);

const {
  chunkLines,
  directTextUrl,
  jsonAsLines,
  listedName,
  parseListPageExtract,
  rankByTitles,
  rawGitHubUrl,
  runListPageFinder,
  titleMatches,
} = await import("../src/list-page.ts");

const SOURCE = {
  url: "https://github.com/backstage/backstage/blob/master/ADOPTERS.md",
  signal: "runs Backstage",
};
const base = {
  dryRun: false,
  sources: [SOURCE],
  yourEdge: "For a company that runs Backstage — one paved path for agent actions",
  play: "design-partner-loi",
  buyerType: "enterprise",
};

beforeEach(() => {
  enqueued.length = 0;
  roleRejections.length = 0;
  cache.clear();
  queued = new Set();
  webReads = 0;
  llmCalls = 0;
  llmInputs = [];
  llmMaxLines = null;
  contactCalls = [];
  companySearchDomain = "beta.example";
  peopleSearchCalls = [];
  peopleSearchResult = { results: [] };
  contactByName = {};
  verifyCalls = [];
  verifyResult = { verdict: "unknown", costUsd: 0 };
  contactResult = {
    ok: true,
    channel: "email",
    email: "lead@acme.example",
    fullName: "Lee Lead",
    phone: null,
    linkedinUrl: "https://www.linkedin.com/in/lee-lead",
    title: "Head of AI Platform",
    verdict: "pass",
    verdictReason: "owns AI platform",
    costUsd: 0.05,
  };
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A cached extraction row with only a name. */
const cachedRow = (name: string) => ({ name, domain: null, context: null, contacts: [] });

describe("list-page helpers", () => {
  it("reads a GitHub file page raw, and leaves other URLs alone", () => {
    expect(rawGitHubUrl(SOURCE.url)).toBe(
      "https://raw.githubusercontent.com/backstage/backstage/master/ADOPTERS.md",
    );
    expect(rawGitHubUrl("https://github.com/backstage/backstage")).toBeNull();
    expect(rawGitHubUrl("https://example.com/customers")).toBeNull();
  });

  it("fetches plain-text sources directly and leaves web pages to the page reader", () => {
    expect(directTextUrl(SOURCE.url)).toBe(
      "https://raw.githubusercontent.com/backstage/backstage/master/ADOPTERS.md",
    );
    expect(
      directTextUrl("https://raw.githubusercontent.com/argoproj/argo-cd/master/USERS.md"),
    ).toBe("https://raw.githubusercontent.com/argoproj/argo-cd/master/USERS.md");
    expect(directTextUrl("https://landscape.example/api/members/end-users.json")).toBe(
      "https://landscape.example/api/members/end-users.json",
    );
    expect(directTextUrl("https://example.com/data/adopters.yaml")).toBe(
      "https://example.com/data/adopters.yaml",
    );
    expect(directTextUrl("https://example.com/customers")).toBeNull();
    expect(directTextUrl("https://example.com/customers.html")).toBeNull();
    expect(directTextUrl("not a url")).toBeNull();
  });

  it("puts each item of a one-line JSON array on its own line, so no chunk cuts it off", () => {
    const members = [
      { name: "Acme (member)", homepage_url: "https://acme.example" },
      { name: "Gamma", homepage_url: "https://gamma.example" },
    ];
    const lines = jsonAsLines(JSON.stringify(members)).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual(members[1]);
    // An object is pretty-printed; anything that is not JSON is left alone.
    expect(jsonAsLines('{"members":[{"name":"Acme"}]}').split("\n").length).toBeGreaterThan(3);
    expect(jsonAsLines("# Adopters\n| a | b |")).toBe("# Adopters\n| a | b |");
    expect(jsonAsLines("[not json")).toBe("[not json");
  });

  it("chunks on line boundaries under the size limit", () => {
    const chunks = chunkLines(["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n"), 90);
    expect(chunks).toEqual([`${"a".repeat(40)}\n${"b".repeat(40)}`, "c".repeat(40)]);
  });

  it("caps a chunk's lines as well as its size: a bare list is short lines, many companies", () => {
    const list = Array.from({ length: 130 }, (_, i) => `1. [Co ${i}](https://co${i}.example)`);
    const chunks = chunkLines(list.join("\n"));
    expect(chunks.map((c) => c.split("\n").length)).toEqual([60, 60, 10]);
    expect(chunks.join("\n")).toBe(list.join("\n"));
  });

  it("takes the list's own tag off a company's name", () => {
    expect(listedName("Adobe (member)")).toBe("Adobe");
    expect(listedName("Adidas (supporter)")).toBe("Adidas");
    expect(listedName("BMW Group (Adopter)")).toBe("BMW Group");
    expect(listedName("Bloomberg*")).toBe("Bloomberg");
    expect(listedName("Box * (End User)")).toBe("Box");
    // Parentheses that are part of the name stay.
    expect(listedName("Federal Pensions Service (SFPD)")).toBe("Federal Pensions Service (SFPD)");
    expect(listedName("Alphabet (Google)")).toBe("Alphabet (Google)");
    expect(listedName("(member)")).toBe("");
    expect(listedName("Acme (End-Users) **")).toBe("Acme");
    // A long run of marks is trimmed in one pass, not by a backtracking pattern.
    expect(listedName(`Acme${"*".repeat(50_000)}x`)).toHaveLength(50_005);

    const out = parseListPageExtract(
      JSON.stringify({
        companies: [
          { name: "Adobe (member)", website: "https://adobe.example" },
          { name: "(supporter)", website: "https://x.example" },
        ],
      }),
    );
    expect(out.map((c) => c.name)).toEqual(["Adobe"]);
  });

  it("cleans names a page cached before the tag was stripped", async () => {
    await runListPageFinder({ ...base, dryRun: true });
    const key = [...cache.keys()].find((k) => k.startsWith("list-page:"))!;
    const stored = JSON.parse(cache.get(key)!) as Array<{ name: string }>;
    stored[0]!.name = "Acme (member)";
    cache.set(key, JSON.stringify(stored));
    await runListPageFinder({ ...base, limit: 1 });
    expect(enqueued[0]?.payload["company"]).toBe("Acme");
  });

  it("drops cached rows that clean to nothing or to a company already listed", async () => {
    const source = { url: "https://example.com/members", signal: "member" };
    const { extractListPage } = await import("../src/list-page.ts");
    await extractListPage(source, "page text");
    const key = [...cache.keys()].find((k) => k.startsWith("list-page:"))!;
    cache.set(
      key,
      JSON.stringify([
        cachedRow("Acme (member)"),
        cachedRow("(member)"),
        cachedRow("Acme"),
        cachedRow("Beta"),
      ]),
    );
    const out = await extractListPage(source, "page text");
    expect(out.map((c) => c.name)).toEqual(["Acme", "Beta"]);
  });

  it("coerces the extraction and drops nameless rows", () => {
    const out = parseListPageExtract(
      JSON.stringify({
        companies: [
          {
            name: "Acme",
            website: "https://www.acme.example/x",
            contacts: [{ github: "@ada" }],
            context: "portal",
          },
          { name: "", website: "x.example" },
          { name: "NoSite", website: "not a domain", contacts: [{}] },
        ],
      }),
    );
    expect(out).toEqual([
      { name: "Acme", domain: "acme.example", context: "portal", contacts: [{ github: "ada" }] },
      { name: "NoSite", domain: null, context: null, contacts: [] },
    ]);
  });
});

describe("runListPageFinder", () => {
  it("queues the decision owner per company, stamped with the signal, routed to design-partner-loi", async () => {
    const out = await runListPageFinder(base);
    expect(webReads).toBe(0);
    expect(out.candidates).toBe(3);
    expect(out.enqueued).toBe(3);
    const row = enqueued[0]!;
    expect(row.playName).toBe("design-partner-loi");
    expect(row.source).toBe("find:list-page:runs-backstage");
    expect(row.dedupeKey).toBe("list-page:acme.example");
    expect(row.payload).toMatchObject({
      name: "Lee Lead",
      email: "lead@acme.example",
      company: "Acme",
      buyerType: "enterprise",
      title: "Head of AI Platform",
      signal: "runs Backstage",
      signalContext: "Developer portal for every team",
      listContact: "@ada",
      companyDomain: "acme.example",
      icpVerdict: "pass",
    });
    // The contact spine looks the person up by domain only; the listed engineer is not the target.
    expect(contactCalls[0]).toMatchObject({
      fullName: null,
      allowMissingFullName: true,
      companyDomain: "acme.example",
    });
    expect(out.perSource).toEqual([{ source: SOURCE.url, label: "runs Backstage", records: 3 }]);
  });

  it("looks up a missing domain by name, and drops the company when none is found", async () => {
    await runListPageFinder(base);
    expect(
      enqueued.find((r) => r.payload["company"] === "Beta Corp")?.payload["companyDomain"],
    ).toBe("beta.example");
    enqueued.length = 0;
    cache.clear();
    companySearchDomain = null;
    const out = await runListPageFinder(base);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued.map((r) => r.payload["company"])).toEqual(["Acme", "Gamma"]);
  });

  it("skips companies already queued before any spend", async () => {
    queued = new Set(["list-page:acme.example"]);
    const out = await runListPageFinder(base);
    expect(out.droppedDuplicate).toBe(1);
    expect(contactCalls.map((c) => c["companyDomain"])).not.toContain("acme.example");
  });

  it("extracts an unchanged page once, then reads it from the cache", async () => {
    await runListPageFinder({ ...base, dryRun: true });
    const first = llmCalls;
    expect(first).toBeGreaterThan(0);
    await runListPageFinder({ ...base, dryRun: true });
    expect(llmCalls).toBe(first);
  });

  it("stops at the per-run limit and at the cost cap", async () => {
    const limited = await runListPageFinder({ ...base, limit: 1 });
    expect(limited.enqueued).toBe(1);
    expect(limited.halted).toBe("limit (1)");
    enqueued.length = 0;
    const capped = await runListPageFinder({ ...base, maxCostUsd: 0.05 });
    expect(capped.enqueued).toBe(1);
    expect(capped.halted).toBe("max-cost cap (0.05)");
  });

  it("persists a role rejection so the company is not re-worked", async () => {
    contactResult = { ok: false, reason: "role", detail: "IC engineer", costUsd: 0.03 };
    const out = await runListPageFinder({ ...base, limit: 1 });
    expect(out.droppedRole).toBe(1);
    expect(roleRejections[0]).toMatchObject({
      playName: "design-partner-loi",
      dedupeKey: "list-page:acme.example",
      reason: "IC engineer",
    });
  });

  it("enqueues nothing without the design-partner-loi route", async () => {
    const out = await runListPageFinder({ ...base, play: undefined });
    expect(out.enqueued).toBe(0);
    expect(out.halted).toMatch(/design-partner-loi only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a JSON members file with one free fetch, every member reaching the extractor", async () => {
    // One line of JSON, longer than a chunk: cut at the chunk size it would
    // lose every member after the first few.
    const members = Array.from({ length: 120 }, (_, i) => ({
      name: `Member ${i}`,
      homepage_url: `https://member${i}.example`,
      description: "x".repeat(60),
    }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(members),
    }));
    const out = await runListPageFinder({
      ...base,
      dryRun: true,
      sources: [{ url: "https://landscape.example/api/end-users.json", signal: "member" }],
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://landscape.example/api/end-users.json");
    expect(webReads).toBe(0);
    expect(out.perSource?.[0]?.error).toBeUndefined();
    expect(llmInputs.length).toBeGreaterThan(1);
    const sent = llmInputs.join("\n").split("\n");
    expect(sent).toHaveLength(120);
    expect(JSON.parse(sent[119]!)).toMatchObject({ name: "Member 119" });
  });

  it("halves a chunk whose reply was cut off, and keeps every company", async () => {
    const rows = Array.from(
      { length: 9 },
      (_, i) => `| [Co ${i}](https://co${i}.example) |  | Uses it |`,
    );
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => rows.join("\n"),
    }));
    llmMaxLines = 3;
    const out = await runListPageFinder({ ...base, dryRun: true });
    expect(out.perSource?.[0]).toMatchObject({ records: 9 });
    expect(out.perSource?.[0]?.error).toBeUndefined();
    // 9 lines → 5 + 4 → (3 + 2) + (2 + 2): seven calls, three of them cut off.
    expect(llmInputs.map((m) => m.split("\n").length)).toEqual([9, 5, 3, 2, 4, 2, 2]);
  });

  it("gives the source up when halving cannot make the reply fit", async () => {
    llmMaxLines = 0;
    const out = await runListPageFinder({ ...base, dryRun: true });
    expect(out.perSource?.[0]?.records).toBe(0);
    expect(out.perSource?.[0]?.error).toMatch(/truncated at max_tokens/);
    // Nothing half-extracted is cached as the page's companies.
    expect([...cache.keys()].filter((k) => k.startsWith("list-page:"))).toEqual([]);
  });

  it("tries a failed read again before giving the source up", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(async () => {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      });
      fetchMock.mockImplementationOnce(async () => ({
        ok: false,
        status: 503,
        text: async () => "",
      }));
      const run = runListPageFinder({ ...base, dryRun: true });
      await vi.runAllTimersAsync();
      const out = await run;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(out.candidates).toBe(3);
      expect(out.perSource?.[0]?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three failed reads, and does not retry a missing file", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => {
        throw new Error("Unable to connect");
      });
      const run = runListPageFinder({ ...base, dryRun: true });
      await vi.runAllTimersAsync();
      const out = await run;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(out.perSource?.[0]).toMatchObject({ records: 0, error: "Unable to connect" });

      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => ({ ok: false, status: 404, text: async () => "" }));
      const missing = runListPageFinder({ ...base, dryRun: true });
      await vi.runAllTimersAsync();
      expect((await missing).perSource?.[0]?.error).toMatch(/HTTP 404/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockImplementation(defaultFetch);
      vi.useRealTimers();
    }
  });

  it("draws from every list in turn, and works a company two lists name once", async () => {
    const second = [
      "| [Delta](https://delta.example) |  | Pipelines |",
      "| [Acme](https://www.acme.example) |  | Also here |",
      "| [Echo](https://echo.example) |  | Pipelines |",
    ].join("\n");
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (url.includes("/apache/airflow/") ? second : ADOPTERS),
    }));
    try {
      const out = await runListPageFinder({
        ...base,
        limit: 4,
        sources: [
          SOURCE,
          {
            url: "https://github.com/apache/airflow/blob/main/INTHEWILD.md",
            signal: "runs Airflow",
          },
        ],
      });
      expect(enqueued.map((r) => [r.payload["company"], r.payload["signal"]])).toEqual([
        ["Acme", "runs Backstage"],
        ["Delta", "runs Airflow"],
        ["Beta Corp", "runs Backstage"],
        ["Echo", "runs Airflow"],
      ]);
      // Acme's second listing is a duplicate, skipped free.
      expect(out.droppedDuplicate).toBe(1);
      expect(out.halted).toBe("limit (4)");
    } finally {
      fetchMock.mockImplementation(defaultFetch);
    }
  });

  it("stops reading paid pages once the cost cap is reached", async () => {
    const out = await runListPageFinder({
      ...base,
      dryRun: true,
      maxCostUsd: 0.002,
      sources: [
        { url: "https://example.com/customers", signal: "customer of Example" },
        { url: "https://example.org/customers", signal: "customer of Other" },
      ],
    });
    // One web read costs the whole cap: the second page is never read.
    expect(webReads).toBe(1);
    expect(out.perSource).toHaveLength(1);
    expect(out.halted).toBe("max-cost cap (0.002)");
  });

  it("reads any other page through webRead", async () => {
    const out = await runListPageFinder({
      ...base,
      sources: [{ url: "https://example.com/customers", signal: "customer of Example" }],
    });
    expect(webReads).toBe(1);
    expect(out.candidates).toBe(1);
    expect(enqueued[0]?.source).toBe("find:list-page:customer-of-example");
  });
});

const person = (full_name: string, title: string, email?: string) => ({
  full_name,
  title,
  ...(email ? { best_work_email: email } : {}),
});

describe("jobTitles targeting", () => {
  const titles = ["Head of AI Platform", "VP Platform Engineering", "CTO"];

  it("ranks people by the order of the wanted titles, work email breaking ties", () => {
    const ranked = rankByTitles(
      [
        person("Pat PR", "Head of Communications"),
        person("Cam CTO", "CTO"),
        person("Val VP", "VP, Platform Engineering", "val@acme.example"),
        person("Vic VP", "VP Platform Engineering"),
        person("Ada AI", "Head of AI Platform"),
        { title: "Head of AI Platform" },
      ] as never,
      titles,
    );
    expect(ranked.map((p) => p.full_name)).toEqual([
      "Ada AI",
      "Val VP",
      "Vic VP",
      "Cam CTO",
      "Pat PR",
    ]);
  });

  it("matches a title on whole words, with the long forms people write", () => {
    // Substrings: dire-cto-r, ret-ai-l, tr-ai-ning.
    expect(titleMatches("Senior Director, Thought Leader Engagement", "CTO")).toBe(false);
    expect(titleMatches("Head of Retail", "Head of AI")).toBe(false);
    expect(titleMatches("Director of Training", "Director of AI")).toBe(false);
    expect(titleMatches("Head of Airfreight & Air Operations", "Head of AI")).toBe(false);

    expect(titleMatches("Vice President, Artificial Intelligence", "VP of AI")).toBe(true);
    expect(titleMatches("Group SVP of AI", "VP of AI")).toBe(true);
    expect(titleMatches("Chief Technology Officer", "CTO")).toBe(true);
    expect(titleMatches("Chief Data Analytics & AI Officer", "Chief AI Officer")).toBe(true);
    expect(titleMatches("Sr. Director of Engineering, Applied AI", "Director of AI")).toBe(true);
    expect(titleMatches("VP of Engineering, Head of AI/ML", "Head of AI")).toBe(true);
    expect(titleMatches("Head of Machine Learning Platform", "Head of ML")).toBe(true);

    expect(titleMatches(null, "CTO")).toBe(false);
    expect(titleMatches("CTO", "of the")).toBe(false);
  });

  it("tries only people whose title matches a wanted one", async () => {
    // The search's own title filter is loose: at a large company it returns
    // senior people of every function.
    peopleSearchResult = {
      results: [
        person("Pat PR", "Head of Communications"),
        person("Dee Docs", "Head of Documentation"),
        person("Reg Retail", "Senior Director of Retail"),
      ],
    };
    const out = await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(contactCalls).toHaveLength(0);
    expect(out.droppedRole).toBe(1);
    expect(out.costUsd).toBeCloseTo(0.01, 5);
  });

  it("searches the domain for the titles and hands the best match to the contact spine", async () => {
    peopleSearchResult = {
      results: [
        person("Pat PR", "Head of Communications"),
        person("Ada AI", "Head of AI Platform", "ada@acme.example"),
      ],
    };
    await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(peopleSearchCalls[0]).toMatchObject({
      companyDomains: ["acme.example"],
      jobTitles: titles,
    });
    expect(contactCalls[0]).toMatchObject({
      fullName: "Ada AI",
      knownEmail: "ada@acme.example",
      titleHint: "Head of AI Platform",
    });
    expect(enqueued[0]?.payload["company"]).toBe("Acme");
  });

  it("tries the next match after a role rejection, and records the company once when all fail", async () => {
    peopleSearchResult = {
      results: [
        person("A One", "CTO"),
        person("B Two", "CTO"),
        person("C Three", "CTO"),
        person("D Four", "CTO"),
      ],
    };
    contactResult = { ok: false, reason: "role", detail: "not the buyer", costUsd: 0.02 };
    const out = await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(contactCalls.map((c) => c["fullName"])).toEqual(["A One", "B Two", "C Three"]);
    expect(out.droppedRole).toBe(1);
    expect(roleRejections).toHaveLength(1);

    contactCalls = [];
    roleRejections.length = 0;
    contactByName = {
      "B Two": {
        ...contactResult,
        ok: true,
        channel: "email",
        email: "b@acme.example",
        fullName: "B Two",
        title: "CTO",
        costUsd: 0.02,
      },
    };
    const second = await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(contactCalls.map((c) => c["fullName"])).toEqual(["A One", "B Two"]);
    expect(second.enqueued).toBe(1);
  });

  it("remembers a company with no matching person for a while, without rejecting it", async () => {
    const none = await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(contactCalls).toHaveLength(0);
    expect(none.droppedRole).toBe(1);
    // No rejected row: that would keep the company out for good.
    expect(roleRejections).toHaveLength(0);
    expect(enqueued).toHaveLength(0);

    // The next run skips Acme free and moves on to the next company.
    peopleSearchCalls = [];
    const next = await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(next.droppedDuplicate).toBe(1);
    expect(peopleSearchCalls.map((c) => c["companyDomains"])).toEqual([["beta.example"]]);
  });

  it("looks at a missed company again when the wanted titles change, not when they are reordered", async () => {
    await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });

    peopleSearchCalls = [];
    await runListPageFinder({ ...base, jobTitles: titles.toReversed(), limit: 1 });
    expect(peopleSearchCalls.map((c) => c["companyDomains"])).toEqual([["beta.example"]]);

    peopleSearchCalls = [];
    await runListPageFinder({ ...base, jobTitles: [...titles, "Head of AI"], limit: 1 });
    expect(peopleSearchCalls.map((c) => c["companyDomains"])).toEqual([["acme.example"]]);
  });

  it("a dry run and a failed search remember nothing", async () => {
    await runListPageFinder({ ...base, jobTitles: titles, limit: 1, dryRun: true });
    peopleSearchResult = { status: "error", results: [] };
    const failed = await runListPageFinder({ ...base, jobTitles: titles, limit: 1 });
    expect(failed.droppedEnrichment).toBe(1);
    expect(roleRejections).toHaveLength(0);
    expect([...cache.keys()].filter((k) => k.startsWith("list-page-miss:"))).toEqual([]);
  });
});

describe("verify: a third-party list checked against the company's own evidence", () => {
  const verify = { names: ["Browserbase"], via: ["subprocessors" as const] };
  const checked = { ...base, sources: [{ ...SOURCE, verify }], limit: 1 };

  it("a source without verify never checks and stamps nothing", async () => {
    await runListPageFinder({ ...base, limit: 1 });
    expect(verifyCalls).toHaveLength(0);
    expect(enqueued[0]?.payload).not.toHaveProperty("signalVerified");
    expect(enqueued[0]?.payload).not.toHaveProperty("signalEvidenceUrl");
  });

  it("checks before the paid contact step and stamps a confirmed row with its evidence", async () => {
    verifyResult = {
      verdict: "confirmed",
      url: "https://acme.example/legal/subprocessors",
      costUsd: 0,
    };
    await runListPageFinder(checked);
    expect(verifyCalls[0]).toEqual({ company: "Acme", domain: "acme.example", verify });
    expect(enqueued[0]?.payload).toMatchObject({
      signalVerified: "confirmed",
      signalEvidenceUrl: "https://acme.example/legal/subprocessors",
    });
  });

  it("keeps a company with no evidence either way, labelled unconfirmed", async () => {
    verifyResult = { verdict: "unknown", costUsd: 0.004 };
    const out = await runListPageFinder(checked);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["signalVerified"]).toBe("unconfirmed");
    expect(enqueued[0]?.payload).not.toHaveProperty("signalEvidenceUrl");
    expect(out.costUsd).toBeCloseTo(0.054);
  });

  it("drops a company whose own subprocessor list leaves the vendor out, recorded once, before any contact spend", async () => {
    verifyResult = {
      verdict: "absent",
      url: "https://acme.example/legal/subprocessors",
      costUsd: 0,
    };
    const out = await runListPageFinder({ ...checked, jobTitles: ["CTO"] });
    expect(out.enqueued).toBe(0);
    expect(out.droppedLowSignal).toBe(1);
    expect(peopleSearchCalls).toHaveLength(0);
    expect(contactCalls).toHaveLength(0);
    expect(roleRejections[0]).toMatchObject({
      dedupeKey: "list-page:acme.example",
      kind: "signal",
      reason: "https://acme.example/legal/subprocessors lists subprocessors without Browserbase",
    });
  });

  it("a dry run never checks", async () => {
    await runListPageFinder({ ...checked, dryRun: true });
    expect(verifyCalls).toHaveLength(0);
  });
});
