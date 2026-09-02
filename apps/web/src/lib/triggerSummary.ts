import type { TriggerView } from "@oneshot-gtm/shared-types";

/**
 * One reading of the trigger list, for the two headers that summarise it.
 *
 * The Today page's scheduler strip and the Queue page's trigger panel both
 * report how many finders are on and when the next one ticks. Computing that
 * twice is how the two end up disagreeing about the same ledger, which is the
 * reason `doctorSummary.ts` exists in the same shape.
 *
 * Pure, so it is testable without a DOM and callable during render.
 */

export interface TriggerSummary {
  /** Enabled, whatever their readiness. */
  enabled: number;
  /** Mid-run right now, per the server. */
  running: number;
  /** Enabled but refusing to fire until they are configured. */
  notReady: number;
  /** Past due, in ms, counted across enabled and ready triggers. */
  overdue: number;
  /** Soonest upcoming tick in ms, or null when nothing is scheduled. */
  nextDueMs: number | null;
}

/**
 * Milliseconds until this trigger's next poll. Negative when overdue.
 *
 * Null for anything without a schedule to compute from. A never-polled trigger
 * is the case that matters: `intervalMs - now()` would make it look ~57 years
 * overdue, when in truth the scheduler simply has not reached it yet.
 */
export function dueInMs(t: TriggerView, now = Date.now()): number | null {
  if (!t.enabled || t.ready === false || t.running || !t.lastPolledAt) return null;
  return new Date(t.lastPolledAt).getTime() + t.intervalMs - now;
}

export function summarizeTriggers(triggers: TriggerView[], now = Date.now()): TriggerSummary {
  const due = triggers.map((t) => dueInMs(t, now));

  return {
    enabled: triggers.filter((t) => t.enabled).length,
    running: triggers.filter((t) => t.running).length,
    // `ready` is absent on older servers, and absent means ready.
    notReady: triggers.filter((t) => t.enabled && t.ready === false).length,
    overdue: due.filter((ms) => ms != null && ms < 0).length,
    nextDueMs:
      due.filter((ms): ms is number => ms != null && ms >= 0).toSorted((a, b) => a - b)[0] ?? null,
  };
}
