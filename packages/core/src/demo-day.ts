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
 *
 * A month alone cannot say whether demo day is still ahead once that month
 * arrives: YC S26 demoed on September 10, so "this month" on the 29th was a
 * lie. Inside the demo-day month, only an exact date may call it upcoming;
 * without one the status is "this month", which reads as "may already have
 * passed" and is never written as timing.
 */

/** Season letter in a cohort id → month index (0-11) of that season's demo day. */
const SEASONAL_DEMO_DAYS: Record<string, { pattern: RegExp; months: Record<string, number> }> = {
  // Y Combinator: Winter → March, Spring (p/x) → June, Summer → September, Fall → December.
  yc: {
    pattern: /^yc[-\s]?([wpxsf])(\d{2})$/i,
    months: { w: 2, p: 5, x: 5, s: 8, f: 11 },
  },
};

/**
 * Exact demo-day dates, when known, by cohort id (lowercase, as the pattern
 * normalises it). A row may also carry its own `demoDayDate`, which wins.
 */
const KNOWN_DEMO_DAY_DATES: Record<string, string> = {
  "yc-s26": "2026-09-10",
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

/**
 * `this month`: now is inside the demo-day month and the exact day is unknown,
 * so it may already have passed. Only `upcoming` is timing a draft may use.
 */
export type DemoDayStatus = "passed" | "this month" | "upcoming";

export interface DemoDay {
  /** "March 2026", or "September 10, 2026" when the exact date is known. */
  month: string;
  /** `2026-03`, the stable form a row carries. */
  isoMonth: string;
  status: DemoDayStatus;
  /** Whole months between now and the demo-day month, never negative. */
  monthsAway: number;
  /** `2026-09-10` when the exact date is known. */
  isoDate?: string;
  /** Whole days between today and the exact date, never negative. Set with `isoDate`. */
  daysAway?: number;
}

function normaliseCohortId(cohortId: string): string | null {
  for (const [prefix, schedule] of Object.entries(SEASONAL_DEMO_DAYS)) {
    const m = schedule.pattern.exec(cohortId.trim());
    if (m) return `${prefix}-${m[1]!.toLowerCase()}${m[2]}`;
  }
  return null;
}

/** `2026-09-10` for a cohort whose exact demo day is known; null otherwise. */
export function cohortDemoDayDate(cohortId: string | null | undefined): string | null {
  const id = cohortId?.trim() ? normaliseCohortId(cohortId) : null;
  return (id && KNOWN_DEMO_DAY_DATES[id]) ?? null;
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

/** A `YYYY-MM-DD` demo day judged against `now` (UTC days). */
export function demoDayFromDate(
  isoDate: string | null | undefined,
  now: Date = new Date(),
): DemoDay | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate?.trim() ?? "");
  if (!m) return null;
  const byMonth = demoDayFromMonth(`${m[1]}-${m[2]}`, now);
  const day = Number(m[3]);
  if (!byMonth || day < 1 || day > 31) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((target - today) / 86_400_000);
  return {
    ...byMonth,
    month: `${MONTH_NAMES[Number(m[2]) - 1]} ${day}, ${m[1]}`,
    status: diffDays < 0 ? "passed" : "upcoming",
    isoDate: `${m[1]}-${m[2]}-${m[3]}`,
    daysAway: Math.abs(diffDays),
  };
}

/** The demo day of a cohort id, judged against `now`. Null when the schedule is unknown. */
export function cohortDemoDay(
  cohortId: string | null | undefined,
  now: Date = new Date(),
): DemoDay | null {
  return (
    demoDayFromDate(cohortDemoDayDate(cohortId), now) ??
    demoDayFromMonth(cohortDemoDayMonth(cohortId), now)
  );
}

/**
 * A row's demo day: its stamped `demoDayDate`, else a known exact date for its
 * `cohort`, else its stamped `demoDayMonth`, else the month from its `cohort`.
 * Reads the fields generically, so any finder that stamps them gets the fact
 * without a play naming it.
 */
export function demoDayOf(
  target: object | null | undefined,
  now: Date = new Date(),
): DemoDay | null {
  if (!target) return null;
  const t = target as { demoDayDate?: unknown; demoDayMonth?: unknown; cohort?: unknown };
  const exact =
    (typeof t.demoDayDate === "string" ? demoDayFromDate(t.demoDayDate, now) : null) ??
    (typeof t.cohort === "string" ? demoDayFromDate(cohortDemoDayDate(t.cohort), now) : null);
  if (exact) return exact;
  if (typeof t.demoDayMonth === "string") {
    const stamped = demoDayFromMonth(t.demoDayMonth, now);
    if (stamped) return stamped;
  }
  return typeof t.cohort === "string" ? cohortDemoDay(t.cohort, now) : null;
}

/** "March 2026 (passed, ~6 months ago)". The text a prompt and a classifier see. */
export function describeDemoDay(d: DemoDay): string {
  if (d.daysAway !== undefined) {
    const days = `${d.daysAway} day${d.daysAway === 1 ? "" : "s"}`;
    if (d.status === "passed") return `${d.month} (passed, ${days} ago)`;
    return d.daysAway === 0 ? `${d.month} (today)` : `${d.month} (upcoming, in ${days})`;
  }
  const n = d.monthsAway;
  const span = `~${n} month${n === 1 ? "" : "s"}`;
  if (d.status === "passed") return `${d.month} (passed, ${span} ago)`;
  if (d.status === "this month") {
    return `${d.month} (this month, exact date unknown: it may already have passed)`;
  }
  return `${d.month} (upcoming, in ${span})`;
}

/** The `DEMO DAY:` input line, or null when the demo day is unknown. */
export function demoDayLine(d: DemoDay | null): string | null {
  return d ? `DEMO DAY: ${describeDemoDay(d)}` : null;
}

/** Demo day is no longer safely ahead of the reader: passed, or maybe passed. */
export function demoDayMayHavePassed(d: DemoDay | null): boolean {
  return d?.status === "passed" || d?.status === "this month";
}

/**
 * A body that mentions demo day for a prospect whose demo day has passed, or
 * may have (inside its month with no exact date). Deliberately word-level:
 * there is nothing to say about it that a cold email needs, so any mention is
 * held for review.
 */
export function mentionsStaleDemoDay(body: string, d: DemoDay | null): boolean {
  return demoDayMayHavePassed(d) && /\bdemo[\s-]?days?\b/i.test(body);
}
