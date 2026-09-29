import { describe, expect, it } from "vitest";
import { dryRunReturnSummary, shouldReturnToQueue } from "./runReturn.ts";

const live = {
  prevMode: "progress" as const,
  mode: "done" as const,
  fromQueue: true,
  dryRun: true,
  drafts: 10,
  errors: 0,
};

describe("shouldReturnToQueue", () => {
  it("returns after a queue dry run finishes live", () => {
    expect(shouldReturnToQueue(live)).toBe(true);
  });

  it("stays when an old run is reopened (no live progress seen)", () => {
    expect(shouldReturnToQueue({ ...live, prevMode: null })).toBe(false);
    expect(shouldReturnToQueue({ ...live, prevMode: "edit" })).toBe(false);
  });

  it("stays on cancelled or interrupted runs", () => {
    expect(shouldReturnToQueue({ ...live, mode: "cancelled" })).toBe(false);
    expect(shouldReturnToQueue({ ...live, mode: "interrupted" })).toBe(false);
  });

  it("stays on real sends and manual entry", () => {
    expect(shouldReturnToQueue({ ...live, dryRun: false })).toBe(false);
    expect(shouldReturnToQueue({ ...live, fromQueue: false })).toBe(false);
  });

  it("stays when the run errored or drafted nothing", () => {
    expect(shouldReturnToQueue({ ...live, errors: 1 })).toBe(false);
    expect(shouldReturnToQueue({ ...live, drafts: 0 })).toBe(false);
  });
});

describe("dryRunReturnSummary", () => {
  it("carries the counts into the toast", () => {
    expect(dryRunReturnSummary(10, 1)).toBe("10 drafts ready · 1 lint");
    expect(dryRunReturnSummary(1, 0)).toBe("1 draft ready");
  });
});
