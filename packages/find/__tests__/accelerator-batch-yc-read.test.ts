import { beforeEach, expect, it, vi } from "vitest";

// A YC batch larger than the run's `limit` must still be read in full:
// slicing the read to `limit` re-read the same first companies every run.
const requestedLimits: number[] = [];
let dupCalls = 0;

vi.mock("../src/_yc-oss-adapter.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_yc-oss-adapter.ts")>(
    "../src/_yc-oss-adapter.ts",
  );
  return {
    ...actual,
    fetchYcOssBatch: async (_cohort: string, limit: number) => {
      requestedLimits.push(limit);
      const all = Array.from({ length: 150 }, (_, i) => ({
        name: `Company ${i}`,
        slug: `company-${i}`,
        website: `https://company${i}.example`,
        oneLiner: "does a thing",
      }));
      return { records: all.slice(0, limit), costUsd: 0, diagnostic: null };
    },
  };
});
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      // The first 100 companies were queued on earlier runs.
      isQueueDuplicate: () => dupCalls++ < 100,
    }),
  };
});

const { runAcceleratorBatchFinder } = await import("../src/accelerator-batch.ts");

beforeEach(() => {
  requestedLimits.length = 0;
  dupCalls = 0;
});

it("reads the whole YC batch and reaches companies past the run's limit", async () => {
  const out = await runAcceleratorBatchFinder({
    dryRun: true,
    cohorts: [{ cohort: "yc-s26", cohortLabel: "YC Summer 2026" }],
    limit: 100,
    concurrency: 1,
  } as Parameters<typeof runAcceleratorBatchFinder>[0]);
  expect(requestedLimits[0]).toBeGreaterThanOrEqual(150);
  expect(out.candidates).toBe(150);
  expect(out.droppedDuplicate).toBe(100);
  expect(out.enqueued).toBe(50);
});
