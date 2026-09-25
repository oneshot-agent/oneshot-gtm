import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERY_WORDS } from "../src/_query-batch.ts";

// Integration tests for runHiringSignalFinder's company-batching (issue
// #708): a long `companies` list must split into several webSearch queries
// that each stay under the search-engine word-length bound, dedupe hits
// across batches, respect the existing hit/cost guards, and rotate which
// batch starts a run. Downstream enrichment (icpFilter/webRead/complete) is
// never exercised here — every case runs `dryRun: true`, which the finder
// itself short-circuits BEFORE any of those calls (see hiring-signal.ts's
// per-hit loop), so only the ledger's `isQueueDuplicate` boundary needs a
// stub.

const searchCalls: Array<{ query: string; maxResults?: number }> = [];
let webSearchImpl: (query: string) => {
  results: Array<{ url: string; title: string; description: string }>;
  cost: number;
};

vi.mock("../src/_filter.ts", () => ({
  // No ICP configured — same pass-through every other finder test uses
  // (civic-agenda.test.ts, luma.test.ts) so `loadConfig()` never touches disk.
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

const { runHiringSignalFinder } = await import("../src/hiring-signal.ts");

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Job-board URL under one of the default ATS hosts — passes isJobBoardUrl. */
function jobUrl(id: string): string {
  return `https://boards.greenhouse.io/acme/jobs/${id}`;
}

const baseConfig = {
  dryRun: true,
  roles: ["Engineer"],
  yourClaim: "we cut onboarding time in half",
  sinceDays: 14,
  limit: 25,
};

beforeEach(() => {
  searchCalls.length = 0;
  webSearchImpl = () => ({ results: [], cost: 0 });
});

afterEach(() => vi.clearAllMocks());

describe("runHiringSignalFinder — company batching (#708)", () => {
  it("splits a 40-company list into multiple queries, each under the length bound", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Company${String(i).padStart(2, "0")}`);
    webSearchImpl = () => ({ results: [], cost: 0.01 });

    await runHiringSignalFinder({ ...baseConfig, companies });

    expect(searchCalls.length).toBeGreaterThan(1);
    for (const call of searchCalls) {
      expect(wordCount(call.query)).toBeLessThanOrEqual(MAX_QUERY_WORDS);
    }
    // Every company must appear in exactly one query — nobody silently dropped.
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
      // Every batch's search happens to surface the same shared posting,
      // plus one batch-unique posting.
      return {
        results: [
          { url: jobUrl("shared"), title: "Staff Engineer", description: "d" },
          { url: jobUrl(`unique-${call}`), title: "Staff Engineer", description: "d" },
        ],
        cost: 0.01,
      };
    };

    const out = await runHiringSignalFinder({ ...baseConfig, companies });

    expect(searchCalls.length).toBeGreaterThan(1);
    // One shared URL (counted once) + one unique URL per batch.
    expect(out.candidates).toBe(1 + searchCalls.length);
  });

  it("stops issuing batch searches once the hit guard (limit*2) is reached", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Co${i}`);
    // limit=3 → guard trips at 6 hits; the first batch alone returns 6
    // distinct job postings, so no second batch search should fire.
    webSearchImpl = () => ({
      results: Array.from({ length: 6 }, (_, i) => ({
        url: jobUrl(`batch1-${i}`),
        title: "Staff Engineer",
        description: "d",
      })),
      cost: 0.01,
    });

    const out = await runHiringSignalFinder({ ...baseConfig, companies, limit: 3 });

    expect(searchCalls).toHaveLength(1);
    expect(out.candidates).toBe(6);
  });

  it("sums costUsd across every batch search, not just the last", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Vendor${i}`);
    webSearchImpl = () => ({ results: [], cost: 0.02 });

    const out = await runHiringSignalFinder({ ...baseConfig, companies });

    expect(searchCalls.length).toBeGreaterThan(1);
    expect(out.costUsd).toBeCloseTo(0.02 * searchCalls.length, 10);
  });

  it("rotates the starting batch between runs via companyBatchCursor", async () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Org${String(i).padStart(2, "0")}`);
    webSearchImpl = () => ({ results: [], cost: 0.01 });

    await runHiringSignalFinder({ ...baseConfig, companies, companyBatchCursor: 0 });
    const firstRunFirstQuery = searchCalls[0]!.query;
    const batchCount = searchCalls.length;
    expect(batchCount).toBeGreaterThan(1);

    searchCalls.length = 0;
    await runHiringSignalFinder({ ...baseConfig, companies, companyBatchCursor: 1 });
    const secondRunFirstQuery = searchCalls[0]!.query;

    expect(secondRunFirstQuery).not.toBe(firstRunFirstQuery);
  });

  it("an empty companies list issues one query per role, byte-for-byte unchanged (no company clause)", async () => {
    webSearchImpl = () => ({ results: [], cost: 0 });

    await runHiringSignalFinder({ ...baseConfig, companies: [] });

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.query).toBe(
      '"Engineer" last 14 days (site:boards.greenhouse.io OR site:jobs.lever.co OR site:apply.workable.com OR site:jobs.ashbyhq.com)',
    );
  });

  it("an absent companies key issues one query per role, identical to the empty-array case", async () => {
    webSearchImpl = () => ({ results: [], cost: 0 });

    await runHiringSignalFinder({ ...baseConfig });

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.query).toBe(
      '"Engineer" last 14 days (site:boards.greenhouse.io OR site:jobs.lever.co OR site:apply.workable.com OR site:jobs.ashbyhq.com)',
    );
  });
});
