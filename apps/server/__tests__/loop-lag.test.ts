import { expect, it } from "vitest";
import { loopLagChecker, type LoopStall } from "../src/loop-lag.ts";

function checker(threshold = 2_000) {
  let t = 0;
  let step = "idle";
  const stalls: LoopStall[] = [];
  const check = loopLagChecker({
    intervalMs: 1_000,
    thresholdMs: threshold,
    step: () => step,
    now: () => t,
    report: (s) => stalls.push(s),
  });
  return {
    stalls,
    at(ms: number, nextStep = step) {
      t = ms;
      step = nextStep;
      check();
    },
  };
}

it("stays quiet while the checks arrive on time or a little late", () => {
  const c = checker();
  c.at(1_000);
  c.at(2_000);
  c.at(4_900);
  expect(c.stalls).toEqual([]);
});

it("reports a stall past the threshold with the steps before and after it", () => {
  const c = checker();
  c.at(1_000, "linkedin-invite-sweep");
  c.at(10_000, "calendar-poll");
  expect(c.stalls).toEqual([
    { stalledMs: 8_000, stepBefore: "linkedin-invite-sweep", stepAfter: "calendar-poll" },
  ]);
});

it("measures each stall from the previous check, not from the start", () => {
  const c = checker();
  c.at(10_000);
  c.at(11_000);
  c.at(20_000);
  expect(c.stalls.map((s) => s.stalledMs)).toEqual([9_000, 8_000]);
});
