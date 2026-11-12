import type { CadenceView } from "@oneshot-gtm/shared-types";

/**
 * /cadences filters: which step a cadence is on, and when it is due. They live
 * in the URL (`?step=&due=`) beside `sinceRun`, so a filtered view links and
 * survives a reload. Only an active cadence has a next step, so every value
 * but "all"/"any" matches active rows only.
 */
export type CadenceStep =
  | "linkedin-invite"
  | "linkedin-waiting"
  | "linkedin-message"
  | "linkedin-breakup"
  | "email"
  | "direct-mail";
export type CadenceStepFilter = "all" | CadenceStep;
export type CadenceDueFilter = "any" | "overdue" | "soon" | "later" | "invite-expiring";

export interface CadenceFilter {
  step: CadenceStepFilter;
  due: CadenceDueFilter;
}

export const CADENCE_STEPS: readonly CadenceStep[] = [
  "linkedin-invite",
  "linkedin-waiting",
  "linkedin-message",
  "linkedin-breakup",
  "email",
  "direct-mail",
];
export const CADENCE_DUES: readonly Exclude<CadenceDueFilter, "any">[] = [
  "overdue",
  "soon",
  "later",
  "invite-expiring",
];

/** The sequence id of a continuation's connection request (`CONTINUATION_INVITE_ID`). */
const INVITE_STEP_ID = "linkedin:invite";
const DAY_MS = 24 * 3600 * 1000;
/** "Invite expiring": withdrawn within this many days if not accepted. */
export const INVITE_EXPIRING_DAYS = 3;

/**
 * The next step, by sequence id rather than label (labels are config). A
 * LinkedIn message waiting on its invite's acceptance is its own step: there
 * is nothing to send until they accept.
 */
export function cadenceStepOf(c: CadenceView): CadenceStep | null {
  if (c.status !== "active") return null;
  if (c.nextStepChannel === "direct_mail") return "direct-mail";
  if (c.nextStepChannel === "email") return "email";
  if (c.nextStepChannel !== "linkedin") return null;
  if (c.nextStepId === INVITE_STEP_ID) return "linkedin-invite";
  if (c.linkedinWaitingSince != null) return "linkedin-waiting";
  return c.nextStepIsBreakup ? "linkedin-breakup" : "linkedin-message";
}

/** When the next step is due, in ms; NaN when it has no date (or one that doesn't parse). */
function dueMs(c: CadenceView): number {
  return c.nextDueAt === null ? Number.NaN : Date.parse(c.nextDueAt);
}

/** Past due and sendable. A row waiting for acceptance is never overdue: nothing can send. */
export function isOverdueCadence(c: CadenceView, nowIso: string): boolean {
  return c.status === "active" && c.linkedinWaitingSince == null && dueMs(c) <= Date.parse(nowIso);
}

export function matchesCadenceDue(c: CadenceView, due: CadenceDueFilter, nowIso: string): boolean {
  if (due === "any") return true;
  if (c.status !== "active") return false;
  if (due === "overdue") return isOverdueCadence(c, nowIso);
  if (due === "invite-expiring") {
    if (c.linkedinInviteExpiresOn == null) return false;
    const horizon = new Date(Date.parse(nowIso) + INVITE_EXPIRING_DAYS * DAY_MS);
    return c.linkedinInviteExpiresOn <= horizon.toISOString().slice(0, 10);
  }
  const nowMs = Date.parse(nowIso);
  const soon = c.linkedinWaitingSince == null && dueMs(c) > nowMs && dueMs(c) <= nowMs + DAY_MS;
  if (due === "soon") return soon;
  return !soon && !isOverdueCadence(c, nowIso);
}

export function matchesCadenceStep(c: CadenceView, step: CadenceStepFilter): boolean {
  return step === "all" || cadenceStepOf(c) === step;
}

export function filterCadences(
  rows: readonly CadenceView[],
  filter: CadenceFilter,
  nowIso: string,
): CadenceView[] {
  if (filter.step === "all" && filter.due === "any") return [...rows];
  return rows.filter(
    (c) => matchesCadenceStep(c, filter.step) && matchesCadenceDue(c, filter.due, nowIso),
  );
}

export interface CadenceFilterCounts {
  step: Record<CadenceStepFilter, number>;
  due: Record<CadenceDueFilter, number>;
}

/** Each chip's count, under the other dimension's current choice. */
export function cadenceFilterCounts(
  rows: readonly CadenceView[],
  filter: CadenceFilter,
  nowIso: string,
): CadenceFilterCounts {
  const step = Object.fromEntries(
    (["all", ...CADENCE_STEPS] as const).map((s) => [s, 0]),
  ) as Record<CadenceStepFilter, number>;
  const due = Object.fromEntries((["any", ...CADENCE_DUES] as const).map((d) => [d, 0])) as Record<
    CadenceDueFilter,
    number
  >;
  for (const c of rows) {
    if (matchesCadenceDue(c, filter.due, nowIso)) {
      step.all++;
      const s = cadenceStepOf(c);
      if (s) step[s]++;
    }
    if (matchesCadenceStep(c, filter.step)) {
      due.any++;
      for (const d of CADENCE_DUES) if (matchesCadenceDue(c, d, nowIso)) due[d]++;
    }
  }
  return { step, due };
}

const STEP_VALUES: ReadonlySet<string> = new Set(CADENCE_STEPS);
const DUE_VALUES: ReadonlySet<string> = new Set(CADENCE_DUES);

/** The filter half of /cadences' search; unknown values are dropped (no filter). */
export function parseCadenceFilterSearch(search: Record<string, unknown>): {
  step?: CadenceStep;
  due?: Exclude<CadenceDueFilter, "any">;
} {
  const step = search["step"];
  const due = search["due"];
  return {
    ...(typeof step === "string" && STEP_VALUES.has(step) ? { step: step as CadenceStep } : {}),
    ...(typeof due === "string" && DUE_VALUES.has(due)
      ? { due: due as Exclude<CadenceDueFilter, "any"> }
      : {}),
  };
}
