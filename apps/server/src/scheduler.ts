import { demoMode, logEvent, type TelemetryOutcome, postDailySendSummaryIfDue } from "@oneshot-gtm/core";
import {
  nextSleepMs,
  runDueTriggers,
  runPendingRetries,
  type TriggerRunOutcome,
} from "@oneshot-gtm/find";
import { pollInboxBounces, pollInboxReplies } from "@oneshot-gtm/plays";
import { reportServerExecution } from "./telemetry.ts";

/**
 * Map a fired trigger's outcome to a telemetry outcome. A thrown error is an
 * error; so is a finder that returned but `halted` early (e.g. cost cap, all
 * cohorts empty) — that's a degraded run, not a clean success, and lumping it
 * into "ok" would understate the real failure rate. Exported for unit tests.
 */
export function triggerOutcome(o: TriggerRunOutcome): TelemetryOutcome {
  return o.error || o.result?.halted ? "error" : "ok";
}

/**
 * Background scheduler: polls registered triggers on their interval and fires
 * due ones inside the dashboard server process. Safety: per-trigger atomic
 * claim (in `runDueTriggers`) prevents double-spend when a manual run races a
 * tick; tick-level try/catch backs off 60s so one throw can't kill the loop;
 * runs orphaned by process exit are reconciled by the cold-boot sweep. The
 * tick also polls inbox replies and bounces (both non-spending); tick cadence
 * is clamped to REPLY_POLL_MAX so they surface within minutes.
 */
export interface SchedulerHandle {
  stop(): void;
}

const FIRST_TICK_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const REPLY_POLL_MAX_MS = 5 * 60_000;
/**
 * Bounces are swept far less often than replies: the sweep re-reads a 30-day
 * DSN window, so reply-cadence polling would re-parse the same data for
 * nothing, while replies are time-sensitive (cadence might send again).
 */
const BOUNCE_POLL_INTERVAL_MS = 30 * 60_000;

export function startScheduler(): SchedulerHandle {
  // Demo mode idles: firing triggers would hit placeholder credentials and
  // overwrite the seeded last_run_summary / last_polled_at values.
  if (demoMode()) {
    logEvent("demo.scheduler_idle");
    return { stop: () => {} };
  }

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 0 = never polled, so the first tick always sweeps.
  let lastBouncePollAt = 0;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const outcomes = await runDueTriggers();
      const fired = outcomes.filter((o) => o.fired).length;
      // Telemetry per fired trigger — detached, must not delay the tick.
      for (const o of outcomes) {
        if (!o.fired) continue;
        void reportServerExecution(`server.trigger.${o.name}`, {
          outcome: triggerOutcome(o),
          durationMs: o.duration_ms ?? 0,
          flags: ["scheduled"],
        });
      }
      // Reply detection is isolated: an inbox outage must not skip trigger
      // scheduling (or vice-versa), and it never sends, so it can't double-spend.
      let repliesDetected = 0;
      let autoRepliesSkipped = 0;
      try {
        const replyPoll = await pollInboxReplies();
        repliesDetected = replyPoll.repliesDetected;
        autoRepliesSkipped = replyPoll.autoRepliesSkipped;
      } catch (err) {
        logEvent(
          "scheduler.reply_poll.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      // Bounce detection, isolated like the reply poll; non-spending.
      let bouncesRecorded = 0;
      if (Date.now() - lastBouncePollAt >= BOUNCE_POLL_INTERVAL_MS) {
        // Stamped before the await, not after: a slow or failing sweep must not
        // let ticks queue up behind it and then all fire at once.
        lastBouncePollAt = Date.now();
        try {
          bouncesRecorded = (await pollInboxBounces()).recorded;
        } catch (err) {
          logEvent(
            "scheduler.bounce_poll.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
      }
      // Drain outage-deferred candidates (time-windowed finders) now the
      // backend may be healthy again. Isolated like the reply poll — its
      // failure must not skip trigger scheduling.
      try {
        await runPendingRetries();
      } catch (err) {
        logEvent(
          "scheduler.pending_retry.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      // Daily send summary to Slack: fires once per completed UTC day when
      // slackWebhookUrl is set. Isolated like the reply poll — failure must
      // not skip trigger scheduling.
      try {
        await postDailySendSummaryIfDue();
      } catch (err) {
        logEvent(
          "scheduler.daily_summary.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      logEvent("scheduler.tick.done", {
        fired,
        repliesDetected,
        autoRepliesSkipped,
        bouncesRecorded,
        source: "server",
      });
      if (cancelled) return;
      const sleepMs = Math.min(nextSleepMs(outcomes), REPLY_POLL_MAX_MS);
      timer = setTimeout(() => void tick(), sleepMs);
    } catch (err) {
      logEvent(
        "scheduler.tick.failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "error",
      );
      if (!cancelled) timer = setTimeout(() => void tick(), ERROR_BACKOFF_MS);
    }
  };

  // Short initial delay so the HTTP server is bound and the cold-boot sweep
  // has finished writing `killed_by_restart` summaries before the first tick.
  timer = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);

  return {
    stop(): void {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
