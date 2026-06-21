import { logEvent } from "@oneshot-gtm/core";
import { nextSleepMs, runDueTriggers, runPendingRetries } from "@oneshot-gtm/find";
import { pollInboxReplies } from "@oneshot-gtm/plays";
import { reportServerExecution } from "./telemetry.ts";

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
 * (`pollInboxReplies`). That detection otherwise only ran when the founder
 * manually advanced a cadence, so a reply could sit unrecognized for days while
 * the sequence kept emailing. It's read-only apart from the status flip — no
 * step is sent — so it never spends. Tick cadence is clamped to REPLY_POLL_MAX
 * so replies surface within minutes even when no trigger is due for an hour.
 */
export interface SchedulerHandle {
  stop(): void;
}

const FIRST_TICK_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const REPLY_POLL_MAX_MS = 5 * 60_000;

export function startScheduler(): SchedulerHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
          outcome: o.error ? "error" : "ok",
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
      logEvent("scheduler.tick.done", { fired, repliesDetected, source: "server" });
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
