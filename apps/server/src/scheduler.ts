import { logEvent } from "@oneshot-gtm/core";
import { nextSleepMs, runDueTriggers } from "@oneshot-gtm/find";

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
 */
export interface SchedulerHandle {
  stop(): void;
}

const FIRST_TICK_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;

export function startScheduler(): SchedulerHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const outcomes = await runDueTriggers();
      const fired = outcomes.filter((o) => o.fired).length;
      logEvent("scheduler.tick.done", { fired, source: "server" });
      if (cancelled) return;
      const sleepMs = nextSleepMs(outcomes);
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
