/**
 * Format a millisecond duration in interval-sized units — minutes/hours/
 * days rather than seconds/minutes. Use for trigger intervals, "next due
 * in N", "overdue N" — anything where the number is naturally on the
 * order of hours or days.
 *
 * For sub-minute spinner countups use `humanDuration` in `triggerRunState.ts`.
 *
 *   45_000          → "45s"
 *   90_000          → "2m"
 *   5_400_000       → "1.5h"
 *   86_400_000      → "1d"
 *   86_400_000 * 7  → "7d"
 */
export function humanInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = ms / 3600_000;
  if (hours >= 48) return `${(hours / 24).toFixed(hours % 24 === 0 ? 0 : 1)}d`;
  return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
}
