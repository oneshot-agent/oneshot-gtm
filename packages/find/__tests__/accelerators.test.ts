import { describe, expect, it } from "vitest";
import { getAccelerator, latestCohorts, resolveAcceleratorCohorts } from "../src/_accelerators.ts";

const published = (slugs: string[]) => async (slug: string) => slugs.includes(slug);

describe("latestCohorts", () => {
  it("YC: the most recent published seasons, skipping one not out yet", async () => {
    const yc = getAccelerator("yc")!;
    // 25 Sep 2026: summer is current, fall is next and already published.
    const got = await latestCohorts(
      yc,
      new Date("2026-09-25T00:00:00Z"),
      2,
      published(["fall-2026", "summer-2026", "spring-2026"]),
    );
    expect(got.map((c) => c.cohort)).toEqual(["yc-f26", "yc-s26"]);
    expect(got[0]!.cohortLabel).toBe("YC Fall 2026");
    const early = await latestCohorts(
      yc,
      new Date("2026-09-25T00:00:00Z"),
      2,
      published(["summer-2026", "spring-2026"]),
    );
    expect(early.map((c) => c.cohort)).toEqual(["yc-s26", "yc-p26"]);
  });

  it("YC: walks back across a year boundary", async () => {
    const got = await latestCohorts(
      getAccelerator("yc")!,
      new Date("2027-01-10T00:00:00Z"),
      2,
      published(["fall-2026", "summer-2026"]),
    );
    expect(got.map((c) => c.cohort)).toEqual(["yc-f26", "yc-s26"]);
  });

  it("yearly: current year first, each with the previous year as fallback", async () => {
    const got = await latestCohorts(
      getAccelerator("antler")!,
      new Date("2026-03-01T00:00:00Z"),
      1,
      published([]),
    );
    expect(got).toEqual([
      {
        accelerator: "antler",
        cohort: "antler-2026",
        cohortLabel: "Antler 2026",
        year: 2026,
        fallback: { cohort: "antler-2025", cohortLabel: "Antler 2025", year: 2025 },
      },
    ]);
  });
});

describe("resolveAcceleratorCohorts", () => {
  it("expands selections and reports unknown ids", async () => {
    const out = await resolveAcceleratorCohorts(
      [{ id: "SPC" }, { id: "nope" }, { id: "neo", recent: 2 }],
      new Date("2026-09-25T00:00:00Z"),
      published([]),
    );
    expect(out.cohorts.map((c) => c.cohort)).toEqual(["spc-2026", "neo-2026", "neo-2025"]);
    expect(out.unknown).toEqual(["nope"]);
  });
});

describe("ycBatchExists", () => {
  it("caches a published batch but re-checks a miss", async () => {
    const { ycBatchExists, _resetYcBatchExistsCache } = await import("../src/_yc-oss-adapter.ts");
    _resetYcBatchExistsCache();
    let calls = 0;
    let published = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: published ? 200 : 404 });
    }) as unknown as typeof fetch;
    try {
      expect(await ycBatchExists("fall-2026")).toBe(false);
      published = true;
      expect(await ycBatchExists("fall-2026")).toBe(true);
      expect(await ycBatchExists("fall-2026")).toBe(true);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
