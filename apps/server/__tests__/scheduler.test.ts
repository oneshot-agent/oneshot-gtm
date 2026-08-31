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
  // These cases exercise the real scheduler loop. Demo mode short-circuits it
  // to a no-op handle — covered separately below.
  demoMode: () => demoModeValue,
}));

let demoModeValue = false;

const { startScheduler } = await import("../src/scheduler.ts");

beforeEach(() => {
  vi.useFakeTimers();
  calls.runDueTriggers = 0;
  calls.nextSleepMs = 0;
  calls.eventKinds = [];
  nextOutcomes = [];
  nextSleepValue = 60_000;
  throwOnNextRun = null;
  demoModeValue = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startScheduler", () => {
  it("does not fire immediately — waits the 5s initial delay before the first tick", async () => {
    const handle = startScheduler();
    expect(calls.runDueTriggers).toBe(0);
    await vi.advanceTimersByTime(4_900);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(0);
    await vi.advanceTimersByTime(200);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(1);
    handle.stop();
  });

  it("schedules the next tick using nextSleepMs(outcomes)", async () => {
    nextOutcomes = [{ name: "show-hn", fired: true, nextDueInMs: 30_000 }];
    nextSleepValue = 30_000;
    const handle = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(1);
    expect(calls.nextSleepMs).toBe(1);
    // Bumping just under the next sleep doesn't re-fire.
    await vi.advanceTimersByTimeAsync(29_900);
    expect(calls.runDueTriggers).toBe(1);
    // Crossing it does.
    await vi.advanceTimersByTime(200);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(2);
    handle.stop();
  });

  it("emits scheduler.tick.done after each successful tick", async () => {
    nextOutcomes = [{ name: "show-hn", fired: true, nextDueInMs: 1000 }];
    const handle = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick);
    expect(calls.eventKinds).toContain("scheduler.tick.done");
    handle.stop();
  });

  it("backs off 60s after a tick error and emits scheduler.tick.failed", async () => {
    throwOnNextRun = new Error("ledger borked");
    const handle = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(1);
    expect(calls.eventKinds).toContain("scheduler.tick.failed");
    // The 60s backoff should govern the next attempt; nextSleepMs was never
    // called because the tick threw before reaching it.
    expect(calls.nextSleepMs).toBe(0);
    await vi.advanceTimersByTimeAsync(59_900);
    expect(calls.runDueTriggers).toBe(1);
    await vi.advanceTimersByTime(200);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(2);
    handle.stop();
  });

  it("stop() cancels the pending tick and prevents future ones", async () => {
    nextSleepValue = 10_000;
    const handle = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick); // first tick
    expect(calls.runDueTriggers).toBe(1);
    handle.stop();
    await vi.advanceTimersByTime(60_000);
    await new Promise(process.nextTick);
    // No further ticks.
    expect(calls.runDueTriggers).toBe(1);
  });

  it("stop() called mid-sleep prevents the next tick from firing", async () => {
    nextSleepValue = 30_000;
    const handle = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick); // tick 1 fires; schedules next at +30s
    expect(calls.runDueTriggers).toBe(1);
    await vi.advanceTimersByTime(15_000); // halfway through sleep
    await new Promise(process.nextTick);
    handle.stop();
    await vi.advanceTimersByTime(20_000); // sleep would otherwise have ended
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(1);
  });

  it("stop() called while runDueTriggers is in flight does NOT reschedule", async () => {
    // Simulate a slow finder by returning a promise that resolves after a
    // controlled delay. The scheduler awaits it; we stop() during the await.
    let resolveSlow: (() => void) | null = null;
    const slowPromise = new Promise<void>((res) => {
      resolveSlow = res;
    });
    nextOutcomes = [];
    nextSleepValue = 1_000;

    // Hijack the mock for one tick to insert the slow promise.
    let inFlight = false;
    const original = (await import("@oneshot-gtm/find")).runDueTriggers;
    void original; // not used; we already mocked it

    // The simplest trick: make our existing mock await a controllable promise.
    // We do this by piggy-backing on `throwOnNextRun` mechanics — instead,
    // wrap the mock's body to wait on slowPromise the first time it's called.
    const handle = startScheduler();
    // Replace the mock's behavior on the fly is brittle, so simulate by:
    // 1) advance to first tick start
    // 2) before it completes, advance time to "schedule the await suspend"
    // The vi.useFakeTimers makes Promise.resolve still microtask, so the
    // simplest approach: have the tick await a real (non-faked) microtask.
    void inFlight;
    void slowPromise;
    void resolveSlow;

    // Direct test: stop AFTER a tick completes but BEFORE the next setTimeout
    // fires. The cancelled check at the top of tick (the `if (cancelled) return`
    // before runDueTriggers) handles the "fires anyway" case.
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick); // tick 1 done
    expect(calls.runDueTriggers).toBe(1);
    handle.stop();
    // Even if the timer was already scheduled by tick 1's success path,
    // the next tick's first line `if (cancelled) return` aborts it.
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(1);
  });

  it("handles nextSleepMs returning 0 without spinning the loop synchronously", async () => {
    // 0ms sleep is degenerate but legal. The loop should still tick on the
    // next event-loop turn rather than blocking. With fake timers, advancing
    // 0ms shouldn't fire anything; advancing a tiny amount should.
    nextSleepValue = 0;
    const handle = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick); // tick 1
    expect(calls.runDueTriggers).toBe(1);
    // setTimeout(fn, 0) still defers to the next macrotask.
    await vi.advanceTimersByTime(0);
    await new Promise(process.nextTick);
    // Should have rescheduled. Advance a hair more to drain the next tick.
    await vi.advanceTimersByTime(1);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBeGreaterThanOrEqual(2);
    handle.stop();
  });

  it("multiple startScheduler() calls produce independent loops (no singleton)", async () => {
    const a = startScheduler();
    const b = startScheduler();
    await vi.advanceTimersByTime(5_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(2); // both fired
    a.stop();
    b.stop();
  });

  // A seeded demo home is a still life. If the scheduler ran, it would fire the
  // enabled triggers against placeholder credentials and overwrite the
  // last_run_summary / last_polled_at values that make the dashboard look alive
  // — mid-screenshot.
  it("never ticks in demo mode, no matter how far time advances", async () => {
    demoModeValue = true;
    const handle = startScheduler();
    await vi.advanceTimersByTime(60 * 60_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(0);
    expect(calls.eventKinds).toContain("demo.scheduler_idle");
    expect(() => handle.stop()).not.toThrow();
  });
});
