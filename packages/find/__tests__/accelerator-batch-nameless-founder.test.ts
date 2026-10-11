import { expect, it, vi } from "vitest";

// A company's own homepage rarely names its founder. The finder used to drop
// every such company before contact resolution; it now hands the domain to the
// shared spine, which finds a decision owner there.

const spineCalls: Array<Record<string, unknown>> = [];
const enqueued: Array<{ payload: Record<string, unknown> }> = [];
let spineResult: Record<string, unknown> = {};

const record = (name: string, website: string | null) => ({
  name,
  website,
  source: "websearch",
  founderName: null,
  oneLiner: "does x",
  longDescription: null,
  industry: null,
  tags: [],
  ycUrl: null,
  founderLinkedinUrl: null,
  founderPhone: null,
});

vi.mock("../src/_accelerator-search-adapter.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_accelerator-search-adapter.ts")>(
    "../src/_accelerator-search-adapter.ts",
  );
  return {
    ...actual,
    fetchAcceleratorSearch: async () => ({
      records: [record("Koladen", "https://koladen.com"), record("No Site Co", null)],
      costUsd: 0,
      diagnostic: null,
    }),
  };
});
vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({ match: true, reason: "fits" }),
}));
vi.mock("../src/_sdk-safe.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_sdk-safe.ts")>("../src/_sdk-safe.ts");
  return { ...actual, safeCompanySearch: async () => ({ result: { cost: 0, results: [] } }) };
});
vi.mock("../src/_contact.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_contact.ts")>("../src/_contact.ts");
  return {
    ...actual,
    resolveVerifyEnrichQualify: async (args: Record<string, unknown>) => {
      spineCalls.push(args);
      return spineResult;
    },
  };
});
vi.mock("../src/_linkedin.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_linkedin.ts")>("../src/_linkedin.ts");
  return { ...actual, findLinkedInUrl: async () => null };
});
vi.mock("../src/_priority-adapters.ts", () => ({
  enqueueScoredTarget: (_ledger: unknown, row: { payload: Record<string, unknown> }) => {
    enqueued.push(row);
    return enqueued.length;
  },
}));
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "extract",
    // The homepage read finds no founder on the page.
    complete: async () => ({ content: JSON.stringify({ founderName: null }) }),
  };
});
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    webRead: async () => ({
      result: { cost: 0.002, markdown: "# Koladen\nLiquidity for advisors" },
    }),
    getLedger: () => ({ isQueueDuplicate: () => false, enqueueTarget: () => 1 }),
  };
});

const { runAcceleratorBatchFinder } = await import("../src/accelerator-batch.ts");

const run = () =>
  runAcceleratorBatchFinder({
    dryRun: false,
    cohorts: [{ cohort: "antler-2026", cohortLabel: "Antler 2026" }],
    limit: 10,
    concurrency: 1,
  } as Parameters<typeof runAcceleratorBatchFinder>[0]);

it("hands a company with no founder on its page to the spine's domain lookup", async () => {
  spineCalls.length = 0;
  enqueued.length = 0;
  spineResult = {
    ok: true,
    channel: "email",
    email: "dana@koladen.com",
    fullName: "Dana Founder",
    phone: null,
    linkedinUrl: null,
    title: "Co-founder & CEO",
    verdict: "pass",
    verdictReason: "founder",
    costUsd: 0.016,
  };

  const out = await run();

  // Only the company with a domain reaches the spine, with no name and the
  // flag that lets the spine search the domain for one.
  expect(spineCalls).toHaveLength(1);
  expect(spineCalls[0]).toMatchObject({
    fullName: null,
    allowMissingFullName: true,
    companyDomain: "koladen.com",
  });
  expect(out.enqueued).toBe(1);
  expect(enqueued[0]?.payload).toMatchObject({
    name: "Dana Founder",
    email: "dana@koladen.com",
    company: "Koladen",
  });
  // The company with no domain is still dropped: nothing to search.
  expect(out.droppedEnrichment).toBe(1);
});

it("drops the company when the domain lookup names nobody either", async () => {
  spineCalls.length = 0;
  enqueued.length = 0;
  spineResult = { ok: false, reason: "not-found", costUsd: 0.01 };

  const out = await run();

  expect(spineCalls).toHaveLength(1);
  expect(out.enqueued).toBe(0);
  expect(out.droppedEnrichment).toBe(2);
});
