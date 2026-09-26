/**
 * When a cohort's demo day falls, computed from its id: data, not a guess the
 * draft makes. A cohort found in March is a follow-up in May, so the status is
 * always computed at the moment of use, never stored.
 *
 * Only accelerators whose demo day is fixed and public by season are listed.
 * Everyone else returns null, and a null means "unknown": no line reaches the
 * prompt, and no claim either way is made about it.
 *
 * Lives in core so finders (which stamp the month on a row) and plays (which
 * draft weeks later) read the same schedule.
 */

/** Season letter in a cohort id → month index (0-11) of that season's demo day. */
const SEASONAL_DEMO_DAYS: Record<string, { pattern: RegExp; months: Record<string, number> }> = {
  // Y Combinator: Winter → March, Spring (p/x) → June, Summer → September, Fall → December.
  yc: {
    pattern: /^yc[-\s]?([wpxsf])(\d{2})$/i,
    months: { w: 2, p: 5, x: 5, s: 8, f: 11 },
  },
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type DemoDayStatus = "passed" | "this month" | "upcoming";

export interface DemoDay {
  /** "March 2026". */
  month: string;
  /** `2026-03`, the stable form a row carries. */
  isoMonth: string;
  status: DemoDayStatus;
  /** Whole months between now and the demo-day month, never negative. */
  monthsAway: number;
}

/** `2026-03` for a cohort id whose schedule is known; null otherwise. */
export function cohortDemoDayMonth(cohortId: string | null | undefined): string | null {
  const id = cohortId?.trim();
  if (!id) return null;
  for (const schedule of Object.values(SEASONAL_DEMO_DAYS)) {
    const m = schedule.pattern.exec(id);
    if (!m) continue;
    const month = schedule.months[m[1]!.toLowerCase()];
    if (month === undefined) return null;
    return `20${m[2]}-${String(month + 1).padStart(2, "0")}`;
  }
  return null;
}

/** A `YYYY-MM` demo-day month judged against `now` (UTC months). */
export function demoDayFromMonth(
  isoMonth: string | null | undefined,
  now: Date = new Date(),
): DemoDay | null {
  const m = /^(\d{4})-(\d{2})$/.exec(isoMonth?.trim() ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return null;
  const diff = year * 12 + month - (now.getUTCFullYear() * 12 + now.getUTCMonth());
  return {
    month: `${MONTH_NAMES[month]} ${year}`,
    isoMonth: `${m[1]}-${m[2]}`,
    status: diff < 0 ? "passed" : diff === 0 ? "this month" : "upcoming",
    monthsAway: Math.abs(diff),
  };
}

/** The demo day of a cohort id, judged against `now`. Null when the schedule is unknown. */
export function cohortDemoDay(
  cohortId: string | null | undefined,
  now: Date = new Date(),
): DemoDay | null {
  return demoDayFromMonth(cohortDemoDayMonth(cohortId), now);
}

/**
 * A row's demo day: its stamped `demoDayMonth` when present, else computed
 * from its `cohort`. Reads the fields generically, so any finder that stamps
 * either gets the fact without a play naming it.
 */
export function demoDayOf(
  target: object | null | undefined,
  now: Date = new Date(),
): DemoDay | null {
  if (!target) return null;
  const t = target as { demoDayMonth?: unknown; cohort?: unknown };
  if (typeof t.demoDayMonth === "string") {
    const stamped = demoDayFromMonth(t.demoDayMonth, now);
    if (stamped) return stamped;
  }
  return typeof t.cohort === "string" ? cohortDemoDay(t.cohort, now) : null;
}

/** "March 2026 (passed, ~6 months ago)" — the text a prompt and a classifier see. */
export function describeDemoDay(d: DemoDay): string {
  const n = d.monthsAway;
  const span = `~${n} month${n === 1 ? "" : "s"}`;
  if (d.status === "passed") return `${d.month} (passed, ${span} ago)`;
  if (d.status === "this month") return `${d.month} (this month)`;
  return `${d.month} (upcoming, in ${span})`;
}

/** The `DEMO DAY:` input line, or null when the demo day is unknown. */
export function demoDayLine(d: DemoDay | null): string | null {
  return d ? `DEMO DAY: ${describeDemoDay(d)}` : null;
}

/**
 * A body that mentions demo day for a prospect whose demo day has passed.
 * Deliberately word-level: when it has passed there is nothing to say about
 * it that a cold follow-up needs, so any mention is held for review.
 */
export function mentionsStaleDemoDay(body: string, d: DemoDay | null): boolean {
  return d?.status === "passed" && /\bdemo[\s-]?days?\b/i.test(body);
}
