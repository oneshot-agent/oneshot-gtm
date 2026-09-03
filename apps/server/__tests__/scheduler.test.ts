import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerRunOutcome } from "@oneshot-gtm/find";

let nextOutcomes: TriggerRunOutcome[] = [];
let nextSleepValue = 60_000;
let throwOnNextRun: Error | null = null;
// When set, runDueTriggers awaits this before resolving/throwing, so a test
// can suspend a tick mid-flight and control exactly when it resumes.
let runDueTriggersGate: Promise<void> | null = null;
const calls = { runDueTriggers: 0, nextSleepMs: 0, eventKinds: [] as string[] };

vi.mock("@oneshot-gtm/find", () => ({
  runDueTriggers: async () => {
    calls.runDueTriggers++;
    if (runDueTriggersGate) {
      await runDueTriggersGate;
    }
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
  runDueTriggersGate = null;
  demoModeValue = false;
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

  it("stop() called while runDueTriggers is in flight does NOT reschedule", async () => {
    // Suspend runDueTriggers on a controllable gate so the tick genuinely
    // stays in flight (awaiting a real, unresolved promise) while we call
    // stop() — this is what "in flight" has to mean for the test to prove
    // anything about in-flight cancellation.
    let resolveGate: (() => void) | null = null;
    runDueTriggersGate = new Promise<void>((res) => {
      resolveGate = res;
    });
    nextOutcomes = [];
    nextSleepValue = 1_000;

    const handle = startScheduler();
    // Fire the first tick; runDueTriggers is called and suspends on the gate.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.runDueTriggers).toBe(1);

    // Stop while runDueTriggers has genuinely not resolved yet.
    handle.stop();
    // Let the in-flight tick resume and run to completion (post-processing,
    // then the `if (cancelled) return` guard before scheduling the next tick).
    resolveGate!();
    await vi.advanceTimersByTimeAsync(0);

    // The tick must not have rescheduled itself: advancing well past
    // nextSleepValue produces no further calls.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.runDueTriggers).toBe(1);
  });

  it("handles nextSleepMs returning 0 without spinning the loop synchronously", async () => {
    // 0ms sleep is degenerate but legal. The loop should still tick on the
    // next event-loop turn rather than blocking. With fake timers, advancing
    // 0ms shouldn't fire anything; advancing a tiny amount should.
    nextSleepValue = 0;
    const handle = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000); // tick 1
    expect(calls.runDueTriggers).toBe(1);
    // setTimeout(fn, 0) still defers to the next macrotask.
    await vi.advanceTimersByTimeAsync(0);
    // Should have rescheduled. Advance a hair more to drain the next tick.
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.runDueTriggers).toBeGreaterThanOrEqual(2);
    handle.stop();
  });

  it("multiple startScheduler() calls produce independent loops (no singleton)", async () => {
    const a = startScheduler();
    const b = startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
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
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls.runDueTriggers).toBe(0);
    expect(calls.eventKinds).toContain("demo.scheduler_idle");
    expect(() => handle.stop()).not.toThrow();
  });
});
