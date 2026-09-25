import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERY_WORDS } from "../src/_query-batch.ts";

// Integration tests for runJobChangeFinder's company-batching (issue #708):
// a long `companies` list must split into several webSearch queries that
// each stay under the search-engine word-length bound, dedupe hits across
// batches, respect the existing hit/cost guards, and rotate which batch
// starts a run. Downstream enrichment (icpFilter/complete) is never
// exercised here — every case runs `dryRun: true`, which the finder itself
// short-circuits BEFORE any of those calls, so only the ledger's
// `isQueueDuplicate` boundary needs a stub.

const searchCalls: Array<{ query: string; maxResults?: number }> = [];
let webSearchImpl: (query: string) => {
  results: Array<{ url: string; title: string; description: string }>;
  cost: number;
};

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => null,
  icpFilter: async () => ({ match: true, reason: "no ICP set; pass-through" }),
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      isQueueDuplicate: () => false,
    }),
    webSearch: async (input: { query: string; maxResults?: number }) => {
      searchCalls.push(input);
      const out = webSearchImpl(input.query);
      return { result: { results: out.results, cost: out.cost }, receiptId: 1 };
    },
  };
});

const { runJobChangeFinder } = await import("../src/job-change.ts");

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function hitUrl(id: string): string {
  return `https://example.com/post/${id}`;
}

const baseConfig = {
  dryRun: true,
  personas: ["VP Engineering"],
  yourEdge: "we cut migration time in half",
  sinceDays: 14,
  limit: 25,
};

beforeEach(() => {
  searchCalls.length = 0;
  webSearchImpl = () => ({ results: [], cost: 0 });
});

afterEach(() => vi.clearAllMocks());

describe("runJobChangeFinder — company batching (#708)", () => {
  it("splits a 40-company list into multiple queries, each under the length bound", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Company${String(i).padStart(2, "0")}`);
    webSearchImpl = () => ({ results: [], cost: 0.01 });

    await runJobChangeFinder({ ...baseConfig, companies });

    expect(searchCalls.length).toBeGreaterThan(1);
    for (const call of searchCalls) {
      expect(wordCount(call.query)).toBeLessThanOrEqual(MAX_QUERY_WORDS);
    }
    for (const company of companies) {
      const hits = searchCalls.filter((c) => c.query.includes(`"${company}"`));
      expect(hits).toHaveLength(1);
    }
  });

  it("dedupes hits across batches (same URL returned by two different batch queries)", async () => {
    const companies = Array.from({ length: 30 }, (_, i) => `Firm${i}`);
    let call = 0;
    webSearchImpl = () => {
      call++;
      return {
        results: [
          { url: hitUrl("shared"), title: "Jane joined as VP Engineering", description: "d" },
          {
            url: hitUrl(`unique-${call}`),
            title: "Jane joined as VP Engineering",
            description: "d",
          },
        ],
        cost: 0.01,
      };
    };

    const out = await runJobChangeFinder({ ...baseConfig, companies });

    expect(searchCalls.length).toBeGreaterThan(1);
    expect(out.candidates).toBe(1 + searchCalls.length);
  });

  it("stops issuing batch searches once the hit guard (limit*2) is reached", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Co${i}`);
    webSearchImpl = () => ({
      results: Array.from({ length: 6 }, (_, i) => ({
        url: hitUrl(`batch1-${i}`),
        title: "Jane joined as VP Engineering",
        description: "d",
      })),
      cost: 0.01,
    });

    const out = await runJobChangeFinder({ ...baseConfig, companies, limit: 3 });

    expect(searchCalls).toHaveLength(1);
    expect(out.candidates).toBe(6);
  });

  it("sums costUsd across every batch search, not just the last", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Vendor${i}`);
    webSearchImpl = () => ({ results: [], cost: 0.02 });

    const out = await runJobChangeFinder({ ...baseConfig, companies });

    expect(searchCalls.length).toBeGreaterThan(1);
    expect(out.costUsd).toBeCloseTo(0.02 * searchCalls.length, 10);
  });

  it("rotates the starting batch between runs via companyBatchCursor", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Org${String(i).padStart(2, "0")}`);
    webSearchImpl = () => ({ results: [], cost: 0.01 });

    await runJobChangeFinder({ ...baseConfig, companies, companyBatchCursor: 0 });
    const firstRunFirstQuery = searchCalls[0]!.query;
    const batchCount = searchCalls.length;
    expect(batchCount).toBeGreaterThan(1);

    searchCalls.length = 0;
    await runJobChangeFinder({ ...baseConfig, companies, companyBatchCursor: 1 });
    const secondRunFirstQuery = searchCalls[0]!.query;

    expect(secondRunFirstQuery).not.toBe(firstRunFirstQuery);
  });

  it("an empty companies list issues one query per persona, byte-for-byte unchanged (no company clause)", async () => {
    webSearchImpl = () => ({ results: [], cost: 0 });

    await runJobChangeFinder({ ...baseConfig, companies: [] });

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.query).toBe('"joined as VP Engineering" last 14 days');
  });

  it("an absent companies key issues one query per persona, identical to the empty-array case", async () => {
    webSearchImpl = () => ({ results: [], cost: 0 });

    await runJobChangeFinder({ ...baseConfig });

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.query).toBe('"joined as VP Engineering" last 14 days');
  });

  it("stops issuing further batch searches once maxCostUsd is reached MID search phase, not just after it (#708 correction)", async () => {
    // 40 companies split into several batches; each batch search costs more
    // than maxCostUsd on its own, and every search returns zero hits, so the
    // only thing that can stop further paid searches is the pre-search cap
    // check — the post-loop per-hit check is never reached.
    const companies = Array.from({ length: 40 }, (_, i) => `Cap${i}`);
    webSearchImpl = () => ({ results: [], cost: 3 });

    const out = await runJobChangeFinder({
      ...baseConfig,
      companies,
      maxCostUsd: 5,
    });

    expect(searchCalls.length).toBe(2);
    expect(out.costUsd).toBe(6);
    expect(out.halted).toBe("max-cost cap (5)");
  });

  it("halts on maxCostUsd even when every search returns zero hits (the post-loop per-hit check is never reached)", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Zero${i}`);
    webSearchImpl = () => ({ results: [], cost: 10 });

    const out = await runJobChangeFinder({
      ...baseConfig,
      companies,
      maxCostUsd: 1,
    });

    expect(searchCalls.length).toBe(1);
    expect(out.candidates).toBe(0);
    expect(out.halted).toBe("max-cost cap (1)");
  });
});
