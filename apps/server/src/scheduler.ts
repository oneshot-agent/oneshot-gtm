import { demoMode, logEvent, type TelemetryOutcome } from "@oneshot-gtm/core";
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
 * Background scheduler that polls registered triggers on their interval and
 * fires due ones. Runs inside the dashboard server process so the founder
 * doesn't have to keep `bun run cli -- find watch` open in a second terminal
 * for enabled triggers to actually execute.
 *
 * Safety:
 * - Per-trigger atomic claim (in `runDueTriggers`) prevents double-spend if
 *   a manual /api/triggers/:name/run click races with a scheduled tick.
 * - Tick-level try/catch keeps a corrupted ledger row or unexpected throw
 *   from permanently killing the loop; backs off 60s before retrying.
 * - In-flight finder runs that haven't returned when the process exits get
 *   killed mid-run; the cold-boot `sweepStaleRunningTriggers` cleans up
 *   the orphaned `running_started_at` markers on the next start.
 *
 * The tick also polls the inbox for prospect replies and stops their cadences
 * (`pollInboxReplies`), and for delivery failures (`pollInboxBounces`). Both
 * otherwise only ran when the founder manually advanced a cadence, so a reply
 * could sit unrecognized — or a dead address keep receiving paid sends — for
 * days while the sequence kept emailing. Both are read-only apart from the
 * status flip — no step is sent — so neither spends. Tick cadence is clamped to
 * REPLY_POLL_MAX so both surface within minutes even when no trigger is due for
 * an hour.
 */
export interface SchedulerHandle {
  stop(): void;
}

const FIRST_TICK_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const REPLY_POLL_MAX_MS = 5 * 60_000;
/**
 * Bounces are swept far less often than replies. A reply is time-sensitive —
 * every minute it goes unnoticed is a minute the cadence might send again. A
 * bounce has already happened and the sweep re-reads a 30-day window, so
 * running it at reply cadence would re-fetch and re-parse the same DSNs a
 * couple of hundred times a day for no new information.
 */
const BOUNCE_POLL_INTERVAL_MS = 30 * 60_000;

export function startScheduler(): SchedulerHandle {
  // A seeded demo home is a still life: the scheduler would fire its enabled
  // triggers against placeholder credentials and overwrite the very
  // last_run_summary / last_polled_at values that make the dashboard look alive,
  // mid-take. Idle instead — demo mode is for capture, and nothing in it is
  // waiting on new signal.
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
      // One anonymous telemetry event per trigger that actually ran this tick.
      // Best-effort and detached — must not delay the next tick or the reply
      // poll below.
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
      try {
        repliesDetected = (await pollInboxReplies()).repliesDetected;
      } catch (err) {
        logEvent(
          "scheduler.reply_poll.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      // Bounce detection, isolated for the same reasons as the reply poll.
      // Also non-spending: it records delivery failures and stops the cadences
      // of hard-bounced addresses, so the founder stops paying to email
      // mailboxes the receiving server has already refused.
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
      logEvent("scheduler.tick.done", {
        fired,
        repliesDetected,
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
