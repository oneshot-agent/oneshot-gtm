import { describe, expect, it } from "vitest";
import { nextSleepMs, TRIGGERS, type TriggerRunOutcome } from "../src/registry.ts";

describe("nextSleepMs", () => {
  it("defaults to 1h when there are no outcomes", () => {
    expect(nextSleepMs([])).toBe(60 * 60 * 1000);
  });

  it("floors at 60s when a trigger is overdue (negative nextDueInMs)", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: true, nextDueInMs: -5_000 },
      { name: "b", fired: false, nextDueInMs: 10 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(60_000);
  });

  it("ceilings at 1h even when the next-due is far in the future", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: false, nextDueInMs: 24 * 60 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(60 * 60 * 1000);
  });

  it("returns the smallest nextDueInMs inside the [60s, 1h] window", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: false, nextDueInMs: 10 * 60 * 1000 },
      { name: "b", fired: false, nextDueInMs: 5 * 60 * 1000 },
      { name: "c", fired: false, nextDueInMs: 30 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(5 * 60 * 1000);
  });
});

describe("TRIGGERS registry", () => {
  it("exposes the expected built-in triggers", () => {
    const names = TRIGGERS.map((t) => t.name).toSorted();
    expect(names).toEqual(["post-funding-auto", "show-hn", "yc-w26"]);
  });

  it("each trigger has a positive default interval and a run function", () => {
    for (const t of TRIGGERS) {
      expect(t.defaultIntervalMs).toBeGreaterThan(0);
      expect(typeof t.run).toBe("function");
      expect(t.defaultConfig).toBeTypeOf("object");
    }
  });
});
