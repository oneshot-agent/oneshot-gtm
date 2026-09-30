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
let contactCalls: Array<Record<string, unknown>> = [];
let contactResult: Record<string, unknown> = {};
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

vi.mock("../src/_sdk-safe.ts", () => ({
  safeCompanySearch: async () => ({
    result: { cost: 0.01, results: companySearchDomain ? [{ domain: companySearchDomain }] : [] },
  }),
}));

vi.mock("../src/_contact.ts", () => ({
  resolveVerifyEnrichQualify: async (args: Record<string, unknown>) => {
    contactCalls.push(args);
    return contactResult;
  },
  icpFields: () => ({ icpVerdict: "pass", icpVerdictReason: "owns AI platform" }),
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

const fetchMock = vi.fn(async (url: string) => ({
  ok: true,
  status: 200,
  text: async () => (url.startsWith("https://raw.githubusercontent.com/") ? ADOPTERS : ""),
}));

const { chunkLines, parseListPageExtract, rawGitHubUrl, runListPageFinder } =
  await import("../src/list-page.ts");

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
  contactCalls = [];
  companySearchDomain = "beta.example";
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

describe("list-page helpers", () => {
  it("reads a GitHub file page raw, and leaves other URLs alone", () => {
    expect(rawGitHubUrl(SOURCE.url)).toBe(
      "https://raw.githubusercontent.com/backstage/backstage/master/ADOPTERS.md",
    );
    expect(rawGitHubUrl("https://github.com/backstage/backstage")).toBeNull();
    expect(rawGitHubUrl("https://example.com/customers")).toBeNull();
  });

  it("chunks on line boundaries under the size limit", () => {
    const chunks = chunkLines(["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n"), 90);
    expect(chunks).toEqual([`${"a".repeat(40)}\n${"b".repeat(40)}`, "c".repeat(40)]);
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
