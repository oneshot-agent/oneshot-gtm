import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerRunOutcome } from "@oneshot-gtm/find";

let nextOutcomes: TriggerRunOutcome[] = [];
let nextSleepValue = 60_000;
let throwOnNextRun: Error | null = null;
// When set, runDueTriggers awaits this before resolving/throwing, so a test
// can suspend a tick mid-flight and control exactly when it resumes.
let runDueTriggersGate: Promise<void> | null = null;
const calls = {
  runDueTriggers: 0,
  nextSleepMs: 0,
  eventKinds: [] as string[],
  pollInboxBounces: 0,
  pollInboxReplies: 0,
  postDailySendSummaryIfDue: 0,
};

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

vi.mock("@oneshot-gtm/plays", () => ({
  backfillMailAddresses: async () => {},
  pollInboxReplies: async () => {
    calls.pollInboxReplies++;
    return { repliesDetected: 0, autoRepliesSkipped: 0, clean: replyPollCleanValue };
  },
  pollInboxBounces: async () => {
    calls.pollInboxBounces++;
    return { polled: 0, recorded: 0, cadencesStopped: 0, clean: bouncePollCleanValue, details: [] };
  },
}));

vi.mock("@oneshot-gtm/core", () => ({
  loadConfig: () => ({}),
  resolveIdentities: () => (smartleadEnabled ? [{ provider: "smartlead" }] : []),
  logEvent: (kind: string) => {
    calls.eventKinds.push(kind);
  },
  // These cases exercise the real scheduler loop. Demo mode short-circuits it
  // to a no-op handle — covered separately below.
  demoMode: () => demoModeValue,
  postDailySendSummaryIfDue: async (_now: Date, opts: { sweepClean?: boolean }) => {
    calls.postDailySendSummaryIfDue++;
    postDailySendSummaryIfDueOpts.push(opts);
    return false;
  },
  refreshPendingDirectMail: async () => ({ refreshed: 0, failed: 0 }),
}));

let demoModeValue = false;
let smartleadEnabled = false;
let bouncePollCleanValue = true;
let replyPollCleanValue = true;
let postDailySendSummaryIfDueOpts: Array<{ sweepClean?: boolean }> = [];

const { startScheduler } = await import("../src/scheduler.ts");

it("polls Smartlead workspaces at most a minute after a completed tick", async () => {
  smartleadEnabled = true;
  nextSleepValue = 600_000;
  const handle = startScheduler();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls.pollInboxReplies).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls.pollInboxReplies).toBe(2);
  handle.stop();
});

beforeEach(() => {
  vi.useFakeTimers();
  calls.runDueTriggers = 0;
  calls.nextSleepMs = 0;
  calls.eventKinds = [];
  calls.pollInboxBounces = 0;
  calls.pollInboxReplies = 0;
  calls.postDailySendSummaryIfDue = 0;
  nextOutcomes = [];
  nextSleepValue = 60_000;
  throwOnNextRun = null;
  runDueTriggersGate = null;
  demoModeValue = false;
  smartleadEnabled = false;
  bouncePollCleanValue = true;
  replyPollCleanValue = true;
  postDailySendSummaryIfDueOpts = [];
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

  // Issue #71 round-3 review finding: the bounce sweep and the daily-summary
  // watermark stamp used to be governed by fully independent timers
  // (BOUNCE_POLL_INTERVAL_MS=30min vs. every tick). A tick that crossed
  // midnight UTC less than 30 minutes after the last sweep would skip the
  // bounce poll but still stamp the just-completed day's watermark via
  // postDailySendSummaryIfDue — permanently excluding any bounce that
  // hadn't been swept yet from every future daily summary. The scheduler
  // must force the sweep on the tick where the UTC calendar day changes,
  // even inside the 30-minute throttle window.
  it("forces a bounce sweep on the first tick, honors the throttle after, and forces again on UTC day rollover", async () => {
    nextSleepValue = 60_000; // fixed 60s cadence between ticks for this test
    vi.setSystemTime(new Date("2026-08-28T23:55:00.000Z"));
    const handle = startScheduler();

    // First tick ever (lastBouncePollAt === 0): always sweeps.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.pollInboxBounces).toBe(1);

    // A tick 1 minute later, still Aug 28, well inside the 30-minute
    // throttle and no day rollover: must NOT sweep again.
    vi.setSystemTime(new Date("2026-08-28T23:56:00.000Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.pollInboxBounces).toBe(1);

    // The next tick crosses midnight UTC into Aug 29, still well inside the
    // 30-minute throttle window since the last real sweep — this is exactly
    // the scenario the round-3 finding describes. It must sweep anyway.
    vi.setSystemTime(new Date("2026-08-29T00:01:00.000Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.pollInboxBounces).toBe(2);

    // Immediately after, still Aug 29, inside the throttle again: no sweep.
    vi.setSystemTime(new Date("2026-08-29T00:02:00.000Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.pollInboxBounces).toBe(2);

    handle.stop();
  });

  // issue #71 round-4 review finding: forcing the bounce sweep on day
  // rollover is only useful if postDailySendSummaryIfDue actually refuses
  // to stamp the watermark when that forced sweep came back partial. The
  // scheduler must pass the sweep's own `clean` flag through as
  // `sweepClean` on every tick, not just day-rollover ticks.
  it("passes the bounce sweep's clean flag through to postDailySendSummaryIfDue as sweepClean", async () => {
    nextSleepValue = 60_000;
    bouncePollCleanValue = false;
    const handle = startScheduler();

    // First tick ever always sweeps (lastBouncePollAt === 0); the sweep
    // reports clean: false via the mock.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.pollInboxBounces).toBe(1);
    expect(postDailySendSummaryIfDueOpts.at(-1)).toEqual({ sweepClean: false });

    // A clean sweep reports sweepClean: true.
    bouncePollCleanValue = true;
    vi.setSystemTime(new Date(Date.now() + 31 * 60_000)); // clears the 30-min throttle
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.pollInboxBounces).toBe(2);
    expect(postDailySendSummaryIfDueOpts.at(-1)).toEqual({ sweepClean: true });

    handle.stop();
  });

  // issue #71 round-5 review finding: bouncePollClean used to be a `let`
  // re-initialized to `true` at the top of every tick's closure. Sequence:
  // a tick's sweep comes back partial (sweepClean: false, summary correctly
  // deferred, watermark NOT stamped) — the very next tick, inside the
  // 30-minute throttle so no sweep runs at all, would still reset the flag
  // to `true` and hand postDailySendSummaryIfDue a false "clean", stamping
  // the still-incomplete day one tick later. The flag must persist across
  // ticks: a tick with no sweep due must carry forward whatever the last
  // sweep that actually ran reported, not assume clean by default.
  it("keeps sweepClean false on a throttled tick that runs no sweep of its own, after a partial sweep", async () => {
    nextSleepValue = 60_000;
    bouncePollCleanValue = false;
    const handle = startScheduler();

    // First tick ever always sweeps (lastBouncePollAt === 0); reports partial.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.pollInboxBounces).toBe(1);
    expect(postDailySendSummaryIfDueOpts.at(-1)).toEqual({ sweepClean: false });

    // Next tick, 1 minute later: well inside the 30-minute throttle and no
    // day rollover, so no sweep runs. sweepClean must still be false — the
    // partial result from the last real sweep, not reset to true.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.pollInboxBounces).toBe(1); // confirms no sweep ran this tick
    expect(postDailySendSummaryIfDueOpts.at(-1)).toEqual({ sweepClean: false });

    handle.stop();
  });

  // issue #71 round-1 correction: postDailySendSummaryIfDue's watermark
  // stamping was gated only on the bounce sweep's `clean` flag, not on
  // reply-poll completeness — but the summary's `bounced` total also
  // depends on the reply poll (countAutoPermanentBounces reads
  // inbox_replies, which the reply poll writes). A partial reply poll must
  // defer the stamp exactly like a partial bounce sweep does.
  it("passes sweepClean: false when the reply poll is partial even though the bounce sweep is clean", async () => {
    nextSleepValue = 60_000;
    bouncePollCleanValue = true;
    replyPollCleanValue = false;
    const handle = startScheduler();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.pollInboxReplies).toBe(1);
    expect(postDailySendSummaryIfDueOpts.at(-1)).toEqual({ sweepClean: false });

    handle.stop();
  });
});
