import { expect, it, vi } from "vitest";

const lookups: string[] = [];
const icpCalls: string[] = [];

vi.mock("../src/_accelerator-search-adapter.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_accelerator-search-adapter.ts")>(
    "../src/_accelerator-search-adapter.ts",
  );
  return {
    ...actual,
    fetchAcceleratorSearch: async () => ({
      records: [
        {
          name: "Fit Co",
          website: null,
          source: "websearch",
          founderName: null,
          oneLiner: "does x",
          longDescription: null,
          industry: null,
          tags: [],
          ycUrl: null,
          founderLinkedinUrl: null,
          founderPhone: null,
        },
        {
          name: "Off Co",
          website: null,
          source: "websearch",
          founderName: null,
          oneLiner: "does x",
          longDescription: null,
          industry: null,
          tags: [],
          ycUrl: null,
          founderLinkedinUrl: null,
          founderPhone: null,
        },
      ],
      costUsd: 0,
      diagnostic: null,
    }),
  };
});
vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async (args: { candidate: { title: string } }) => {
    icpCalls.push(args.candidate.title);
    return { match: args.candidate.title.includes("Fit"), reason: "r" };
  },
}));
vi.mock("../src/_sdk-safe.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_sdk-safe.ts")>("../src/_sdk-safe.ts");
  return {
    ...actual,
    safeCompanySearch: async (input: { name: string }) => {
      lookups.push(input.name);
      return { result: { cost: 0.01, results: [] } };
    },
  };
});
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({ isQueueDuplicate: () => false, enqueueTarget: () => 1 }),
  };
});

const { runAcceleratorBatchFinder } = await import("../src/accelerator-batch.ts");

it("looks a missing domain up only for a company that passed the ICP gate", async () => {
  const out = await runAcceleratorBatchFinder({
    dryRun: false,
    cohorts: [{ cohort: "antler-2026", cohortLabel: "Antler 2026" }],
    limit: 10,
    concurrency: 1,
  } as Parameters<typeof runAcceleratorBatchFinder>[0]);
  expect(icpCalls.toSorted()).toEqual(["Fit Co", "Off Co"]);
  expect(lookups).toEqual(["Fit Co"]);
  // No domain found: the pipeline still drops it rather than guessing.
  expect(out.droppedEnrichment).toBe(1);
  expect(out.costUsd).toBeCloseTo(0.01);
});
