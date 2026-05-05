import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerRunOutcome } from "@oneshot-gtm/find";

let nextOutcomes: TriggerRunOutcome[] = [];
let nextSleepValue = 60_000;
let throwOnNextRun: Error | null = null;
const calls = { runDueTriggers: 0, nextSleepMs: 0, eventKinds: [] as string[] };

vi.mock("@oneshot-gtm/find", () => ({
  runDueTriggers: async () => {
    calls.runDueTriggers++;
    if (throwOnNextRun) {
      const err = throwOnNextRun;
      throwOnNextRun = null;
      throw err;
    }
    return nextOutcomes;
  },
  nextSleepMs: (outcomes: TriggerRunOutcome[]) => {
    calls.nextSleepMs++;
    void outcomes;
    return nextSleepValue;
  },
}));

vi.mock("@oneshot-gtm/core", () => ({
  logEvent: (kind: string) => {
    calls.eventKinds.push(kind);
  },
}));

const { startScheduler } = await import("../src/scheduler.ts");

beforeEach(() => {
  vi.useFakeTimers();
  calls.runDueTriggers = 0;
  calls.nextSleepMs = 0;
  calls.eventKinds = [];
  nextOutcomes = [];
  nextSleepValue = 60_000;
  throwOnNextRun = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startScheduler", () => {
  it("does not fire immediately — waits the 5s initial delay before the first tick", async () => {
    const handle = startScheduler();
    expect(calls.runDueTriggers).toBe(0);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls.runDueTriggers).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.runDueTriggers).toBe(1);
    handle.stop();
  });

  it("schedules the next tick using nextSleepMs(outcomes)", async () => {
    nextOutcomes = [{ name: "show-hn", fired: true, nextDueInMs: 30_000 }];
    nextSleepValue = 30_000;
    const handle = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.runDueTriggers).toBe(1);
    expect(calls.nextSleepMs).toBe(1);
    // Bumping just under the next sleep doesn't re-fire.
    await vi.advanceTimersByTimeAsync(29_900);
    expect(calls.runDueTriggers).toBe(1);
    // Crossing it does.
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.runDueTriggers).toBe(2);
    handle.stop();
  });

  it("emits scheduler.tick.done after each successful tick", async () => {
    nextOutcomes = [{ name: "show-hn", fired: true, nextDueInMs: 1000 }];
    const handle = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.eventKinds).toContain("scheduler.tick.done");
    handle.stop();
  });

  it("backs off 60s after a tick error and emits scheduler.tick.failed", async () => {
    throwOnNextRun = new Error("ledger borked");
    const handle = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.runDueTriggers).toBe(1);
    expect(calls.eventKinds).toContain("scheduler.tick.failed");
    // The 60s backoff should govern the next attempt; nextSleepMs was never
    // called because the tick threw before reaching it.
    expect(calls.nextSleepMs).toBe(0);
    await vi.advanceTimersByTimeAsync(59_900);
    expect(calls.runDueTriggers).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.runDueTriggers).toBe(2);
    handle.stop();
  });

  it("stop() cancels the pending tick and prevents future ones", async () => {
    nextSleepValue = 10_000;
    const handle = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000); // first tick
    expect(calls.runDueTriggers).toBe(1);
    handle.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    // No further ticks.
    expect(calls.runDueTriggers).toBe(1);
  });

  it("stop() called mid-sleep prevents the next tick from firing", async () => {
    nextSleepValue = 30_000;
    const handle = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000); // tick 1 fires; schedules next at +30s
    expect(calls.runDueTriggers).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000); // halfway through sleep
    handle.stop();
    await vi.advanceTimersByTimeAsync(20_000); // sleep would otherwise have ended
    expect(calls.runDueTriggers).toBe(1);
  });
});
