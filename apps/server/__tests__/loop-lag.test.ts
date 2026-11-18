import { expect, it } from "vitest";
import { loopLagChecker, type LoopStall } from "../src/loop-lag.ts";

function checker() {
  let t = 0;
  const stalls: LoopStall[] = [];
  const lag = loopLagChecker({
    intervalMs: 1_000,
    thresholdMs: 2_000,
    now: () => t,
    report: (s) => stalls.push(s),
  });
  return {
    stalls,
    /** Move the clock to `ms`, then mark a step (or run the check). */
    step(ms: number, name: string) {
      t = ms;
      lag.step(name);
    },
    check(ms: number) {
      t = ms;
      lag.check();
    },
  };
}

it("stays quiet while the checks arrive on time or a little late", () => {
  const c = checker();
  c.check(1_000);
  c.check(2_000);
  c.check(4_900);
  expect(c.stalls).toEqual([]);
});

it("names a synchronous step that started and ended between two checks", () => {
  const c = checker();
  c.check(1_000);
  c.step(1_100, "learning-expiry");
  c.step(9_100, "reply-poll");
  c.check(9_200);
  expect(c.stalls).toEqual([
    {
      stalledMs: 7_200,
      longestStep: "learning-expiry",
      longestStepMs: 8_000,
      steps: ["idle", "learning-expiry", "reply-poll"],
    },
  ]);
});

it("charges a stall with no step change to the step that was running", () => {
  const c = checker();
  c.step(500, "linkedin-invite-sweep");
  c.check(1_000);
  c.check(10_000);
  expect(c.stalls).toEqual([
    {
      stalledMs: 8_000,
      longestStep: "linkedin-invite-sweep",
      longestStepMs: 9_000,
      steps: ["linkedin-invite-sweep"],
    },
  ]);
});

it("measures each stall from the previous check, not from the start", () => {
  const c = checker();
  c.check(10_000);
  c.check(11_000);
  c.check(20_000);
  expect(c.stalls.map((s) => s.stalledMs)).toEqual([9_000, 8_000]);
});
