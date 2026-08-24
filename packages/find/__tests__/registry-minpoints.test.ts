import { describe, expect, it, vi } from "vitest";

// The registry must forward show-hn's `minPoints` config to the finder —
// it silently ignored it before (config said 2, finder ran with default 5).

const runShowHn = vi
  .fn()
  .mockResolvedValue({ source: "find:show-hn", candidates: 0, enqueued: 0, costUsd: 0 });
vi.mock("../src/show-hn.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/show-hn.ts")>("../src/show-hn.ts");
  return { ...actual, runShowHnFinder: runShowHn };
});

const { TRIGGERS } = await import("../src/registry.ts");

describe("show-hn trigger config plumbing", () => {
  it("forwards minPoints when set and omits it when absent", async () => {
    const spec = TRIGGERS.find((t) => t.name === "show-hn")!;
    await spec.run({ sinceDays: 3, limit: 10, maxCostUsd: 5, minPoints: 2 });
    expect(runShowHn).toHaveBeenLastCalledWith(expect.objectContaining({ minPoints: 2 }));
    await spec.run({ sinceDays: 3 });
    expect(runShowHn.mock.calls.at(-1)![0]).not.toHaveProperty("minPoints");
  });
});
