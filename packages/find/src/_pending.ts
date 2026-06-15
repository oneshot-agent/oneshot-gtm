import { getLedger, logEvent } from "@oneshot-gtm/core";
import { isCircuitOpen } from "./_breaker.ts";

/**
 * Retry queue for candidates whose paid contact-resolution hit a TRANSIENT
 * platform error (the OneShot outage). Re-scannable finders self-heal on their
 * next run, but time-windowed ones (luma-events, show-hn) can't re-discover an
 * expired source — so they persist the raw candidate here and a scheduler pass
 * drains it once the backend recovers.
 *
 * Each participating finder registers a retry handler keyed by play name; the
 * handler re-runs that finder's per-candidate resolve→enqueue for one persisted
 * `raw` blob and reports the outcome. Finders with no handler (the re-scannable
 * ones) never persist here, so the runner simply skips/sweeps any it doesn't own.
 */
export type RetryOutcome = "enqueued" | "dropped" | "platform-error";
type RetryHandler = (raw: unknown) => Promise<RetryOutcome>;

const handlers = new Map<string, RetryHandler>();

export function registerPendingRetry(playName: string, handler: RetryHandler): void {
  handlers.set(playName, handler);
}

/** Persist a candidate that hit a transient platform error during resolution. */
export function persistPending(input: {
  playName: string;
  dedupeKey: string;
  source: string;
  raw: unknown;
}): void {
  getLedger().upsertPendingResolution(input);
}

/** Stale cutoff: a candidate not resolved within a week (source likely expired). */
const STALE_MS = 7 * 24 * 3600 * 1000;
/** Cap retries per tick so a large backlog can't stall the scheduler loop. */
const MAX_PER_TICK = 25;

/**
 * Drain pending rows once the platform is healthy. Called by the scheduler tick.
 * Sweeps stale rows first, then retries up to MAX_PER_TICK via each row's
 * registered handler. A still-`platform-error` outcome keeps the row for next
 * tick; enqueued/dropped remove it. Defers entirely while the breaker is open.
 */
export async function runPendingRetries(): Promise<{
  retried: number;
  enqueued: number;
  dropped: number;
  deferred: number;
  swept: number;
}> {
  const ledger = getLedger();
  const swept = ledger.sweepStalePendingResolution(STALE_MS);
  const out = { retried: 0, enqueued: 0, dropped: 0, deferred: 0, swept };
  const rows = ledger.listPendingResolution({ limit: MAX_PER_TICK });
  for (const row of rows) {
    const handler = handlers.get(row.play_name);
    if (!handler) continue; // re-scannable finder (no handler) — leave for the sweep
    if (isCircuitOpen()) {
      out.deferred++;
      continue; // platform still down — don't hammer it
    }
    out.retried++;
    ledger.markPendingResolutionAttempted(row.play_name, row.dedupe_key);
    let outcome: RetryOutcome;
    try {
      outcome = await handler(JSON.parse(row.raw_json));
    } catch (err) {
      logEvent(
        "finder.pending_retry.error",
        { play: row.play_name, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      outcome = "platform-error";
    }
    if (outcome === "enqueued") {
      ledger.deletePendingResolution(row.play_name, row.dedupe_key);
      out.enqueued++;
    } else if (outcome === "dropped") {
      ledger.deletePendingResolution(row.play_name, row.dedupe_key);
      out.dropped++;
    } else {
      out.deferred++; // platform-error: keep for the next tick
    }
  }
  if (out.retried > 0 || out.swept > 0) logEvent("finder.pending_retry.done", out);
  return out;
}

/** Test-only: clear the handler registry between cases. */
export function _clearPendingHandlers(): void {
  handlers.clear();
}
