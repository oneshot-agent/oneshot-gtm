import type { QueueRowView } from "@oneshot-gtm/shared-types";

export interface SignalDay {
  /** Local-formatted day label, e.g. "Mon · Apr 21". */
  label: string;
  count: number;
  /** ms epoch at the start of this calendar day in local time. */
  startMs: number;
}

/**
 * 7-day histogram (oldest → newest) of queue enqueues, bucketed by LOCAL
 * calendar day. Each bar's count is the number of rows whose `foundAt`
 * falls inside that day's local-midnight-to-midnight window.
 *
 * Why calendar buckets, not rolling 24h windows: the labels say "Mon Apr 21"
 * etc, so the bars must mean the same thing. The previous version used
 * `Math.floor((now - ts) / 24h)` which drifted — a row from yesterday at
 * 18:00 viewed at noon today (18h diff = 0.75 days = floor 0) landed in
 * the "today" bucket even though it's clearly yesterday by any calendar.
 *
 * `now` is injected so tests can pin time without faking Date globally.
 * Math.round on the day-diff handles DST transitions where a "day" is
 * 23 or 25 hours of wall-clock time but still one calendar day.
 */
export function buildSignalDays(rows: QueueRowView[], now: Date = new Date()): SignalDay[] {
  const todayStart = startOfLocalDay(now);
  const days: SignalDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - i);
    days.push({
      label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      count: 0,
      startMs: d.getTime(),
    });
  }
  const cutoffMs = days[0]!.startMs;
  for (const r of rows) {
    const ts = new Date(r.foundAt);
    if (Number.isNaN(ts.getTime())) continue;
    const tsStart = startOfLocalDay(ts);
    if (tsStart.getTime() < cutoffMs) continue;
    const dayDiff = Math.round((todayStart.getTime() - tsStart.getTime()) / (24 * 3600 * 1000));
    const idx = 6 - dayDiff;
    if (idx >= 0 && idx < 7) {
      days[idx]!.count += 1;
    }
  }
  return days;
}

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
