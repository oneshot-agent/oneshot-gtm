import { expect, it, vi } from "vitest";

const searched: string[] = [];

vi.mock("../src/_yc-oss-adapter.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_yc-oss-adapter.ts")>(
    "../src/_yc-oss-adapter.ts",
  );
  return {
    ...actual,
    ycBatchExists: async (slug: string) => slug === "summer-2026",
    fetchYcOssBatch: async (cohort: string) => {
      searched.push(cohort);
      return {
        records: [{ name: "YC Co", website: "https://yc.co", source: "yc-oss" }],
        costUsd: 0,
        diagnostic: null,
      };
    },
  };
});
vi.mock("../src/_accelerator-search-adapter.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_accelerator-search-adapter.ts")>(
    "../src/_accelerator-search-adapter.ts",
  );
  return {
    ...actual,
    fetchAcceleratorSearch: async (cohort: string) => {
      searched.push(cohort);
      // This year's cohort is not published yet; last year's is.
      return cohort === "antler-2025"
        ? {
            records: [
              { name: "Antler Co", website: "https://antler.co.example", source: "websearch" },
            ],
            costUsd: 0,
            diagnostic: null,
          }
        : { records: [], costUsd: 0, diagnostic: "none yet" };
    },
  };
});
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {}, getLedger: () => ({ isQueueDuplicate: () => false }) };
});

const { runAcceleratorBatchFinder } = await import("../src/accelerator-batch.ts");

it("resolves accelerators to their latest cohorts and falls back a year when needed", async () => {
  const out = await runAcceleratorBatchFinder({
    dryRun: true,
    accelerators: [{ id: "yc" }, { id: "antler" }, { id: "not-real" }],
    now: new Date("2026-09-25T00:00:00Z"),
    limit: 10,
    concurrency: 1,
  } as Parameters<typeof runAcceleratorBatchFinder>[0]);
  expect(searched).toEqual(["yc-s26", "antler-2026", "antler-2025"]);
  expect(out.candidates).toBe(2);
  expect(out.perCohort).toEqual([
    { cohort: "yc-s26", records: 1 },
    { cohort: "antler-2025", records: 1 },
    { cohort: "not-real", records: 0, error: "unknown accelerator id" },
  ]);
});

it("returns a halted result, not an exception, when nothing resolves", async () => {
  const out = await runAcceleratorBatchFinder({
    dryRun: true,
    accelerators: [{ id: "not-real" }],
    now: new Date("2026-09-25T00:00:00Z"),
  } as Parameters<typeof runAcceleratorBatchFinder>[0]);
  expect(out.halted).toContain("unknown accelerator ids: not-real");
  expect(out.enqueued).toBe(0);
});

it("does not search a fallback year that is already its own entry", async () => {
  searched.length = 0;
  await runAcceleratorBatchFinder({
    dryRun: true,
    accelerators: [{ id: "antler", recent: 2 }],
    now: new Date("2026-09-25T00:00:00Z"),
    concurrency: 1,
  } as Parameters<typeof runAcceleratorBatchFinder>[0]);
  // antler-2026 (empty) must not fall back to antler-2025, which is searched as its own entry.
  expect(searched.filter((c) => c === "antler-2025")).toHaveLength(1);
});
