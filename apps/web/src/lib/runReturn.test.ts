import { describe, expect, it } from "vitest";
import { allTargetsLinked, dryRunReturnSummary, shouldReturnToQueue } from "./runReturn.ts";

const live = {
  watchedLive: true,
  status: "done" as const,
  fromQueue: true,
  dryRun: true,
  drafts: 10,
  errors: 0,
  allLinked: true,
};

describe("shouldReturnToQueue", () => {
  it("returns after a queue dry run finishes live", () => {
    expect(shouldReturnToQueue(live)).toBe(true);
  });

  it("stays when an old run is reopened (never seen running)", () => {
    expect(shouldReturnToQueue({ ...live, watchedLive: false })).toBe(false);
  });

  it("stays on cancelled or interrupted runs", () => {
    expect(shouldReturnToQueue({ ...live, status: "cancelled" })).toBe(false);
    expect(shouldReturnToQueue({ ...live, status: "interrupted" })).toBe(false);
  });

  it("stays on real sends and manual entry", () => {
    expect(shouldReturnToQueue({ ...live, dryRun: false })).toBe(false);
    expect(shouldReturnToQueue({ ...live, fromQueue: false })).toBe(false);
  });

  it("stays when the run errored, drafted nothing, or had a hand-added row", () => {
    expect(shouldReturnToQueue({ ...live, errors: 1 })).toBe(false);
    expect(shouldReturnToQueue({ ...live, drafts: 0 })).toBe(false);
    expect(shouldReturnToQueue({ ...live, allLinked: false })).toBe(false);
  });
});

describe("allTargetsLinked", () => {
  it("needs a queue row for every target", () => {
    expect(allTargetsLinked(2, ["k1", "k2"])).toBe(true);
    expect(allTargetsLinked(2, ["k1", null])).toBe(false);
    expect(allTargetsLinked(2, ["k1"])).toBe(false);
    expect(allTargetsLinked(0, [])).toBe(false);
  });
});

describe("dryRunReturnSummary", () => {
  it("carries the counts into the toast", () => {
    expect(dryRunReturnSummary(10, 1)).toBe("10 drafts ready · 1 lint");
    expect(dryRunReturnSummary(1, 0)).toBe("1 draft ready");
  });
});
