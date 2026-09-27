import { beforeEach, describe, expect, it, vi } from "vitest";

// The backfill's newsfeed pass: bounded by --max-cost-usd, never buying under
// --cache-only, and skipping rows whose capture is still current.

const calls: Array<{ id: number; opts: { cacheOnly?: boolean; remainingUsd?: number } }> = [];

vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  const capture = async (
    id: number,
    _play: string,
    opts: { cacheOnly?: boolean; remainingUsd?: number },
  ) => {
    calls.push({ id, opts });
    if (opts.cacheOnly)
      return { outcome: { status: "skipped", reason: "not-cached", costUsd: 0 }, attached: false };
    if (opts.remainingUsd !== undefined && opts.remainingUsd < 0.07) {
      return { outcome: { status: "skipped", reason: "cost-cap", costUsd: 0 }, attached: false };
    }
    return {
      outcome: {
        status: "captured",
        costUsd: 0.07,
        cached: false,
        feed: { url: "", fetchedAt: "", posts: [] },
      },
      attached: true,
    };
  };
  return {
    ...actual,
    captureNewsfeedForQueueRow: capture,
    captureNewsfeedForProspect: capture,
    isNewsfeedCircuitOpen: () => false,
  };
});

const { hasFreshPointer, runNewsfeedPass } = await import("../src/commands/_newsfeed-pass.ts");

const items = [1, 2, 3, 4].map((id) => ({
  kind: "queue" as const,
  id,
  playName: "luma-events",
  url: `https://www.linkedin.com/in/p${id}`,
}));

beforeEach(() => {
  calls.length = 0;
});

describe("runNewsfeedPass", () => {
  it("stops at the cost ceiling, counting what the research already spent", async () => {
    const tally = await runNewsfeedPass(items, { maxCostUsd: 0.25, spentUsd: 0.1 });
    expect(tally.captured).toBe(2);
    expect(tally.costUsd).toBeCloseTo(0.14, 5);
    expect(tally.cappedAt).toBe(2);
  });

  it("passes cache-only through, so nothing is bought", async () => {
    const tally = await runNewsfeedPass(items, { cacheOnly: true });
    expect(calls.every((c) => c.opts.cacheOnly === true)).toBe(true);
    expect(tally.costUsd).toBe(0);
    expect(tally.skipped).toBe(4);
  });
});

describe("hasFreshPointer", () => {
  it("is fresh inside 14 days and stale after", () => {
    const now = Date.parse("2026-09-27T00:00:00Z");
    expect(hasFreshPointer({ fetchedAt: "2026-09-20T00:00:00Z" }, now)).toBe(true);
    expect(hasFreshPointer({ fetchedAt: "2026-09-01T00:00:00Z" }, now)).toBe(false);
    expect(hasFreshPointer(null, now)).toBe(false);
  });
});
