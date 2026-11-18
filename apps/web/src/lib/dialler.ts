import {
  CALL_OUTCOMES,
  type CallListResponse,
  type CallListRow,
  type CallOutcome,
  type LogCallRequest,
} from "@oneshot-gtm/shared-types";

/**
 * The Calls page's logic, kept out of the components so it can be read and
 * tested without a browser: outcome keys, the call window, Save & next.
 */

/** Each outcome with its key: 1–9 then 0, in list order. */
export const OUTCOME_KEYS: ReadonlyArray<{ outcome: CallOutcome; title: string; key: string }> =
  CALL_OUTCOMES.map((o, i) => ({ outcome: o.outcome, title: o.title, key: String((i + 1) % 10) }));

export function outcomeTitle(outcome: CallOutcome | null): string {
  return CALL_OUTCOMES.find((o) => o.outcome === outcome)?.title ?? "—";
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The clock in one IANA zone: "14:05" and the weekday (0 = Sunday); null for a zone Intl doesn't know. */
export function zoneClock(zone: string, now: Date): { hhmm: string; weekday: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const weekday = WEEKDAY[part("weekday")];
    if (weekday === undefined) return null;
    return { hhmm: `${part("hour")}:${part("minute")}`, weekday };
  } catch {
    return null;
  }
}

/**
 * Inside the call window in every zone the number may be in, read from the
 * browser's clock so it never waits on the next poll. An unknown zone (or
 * none at all) counts as inside, as the server counts it.
 */
export function inCallWindow(
  zones: readonly string[],
  window: CallListResponse["window"],
  now: Date,
): boolean {
  return zones.every((zone) => {
    const clock = zoneClock(zone, now);
    if (!clock) return true;
    if (window.weekdays && (clock.weekday === 0 || clock.weekday === 6)) return false;
    return clock.hhmm >= window.start && clock.hhmm < window.end;
  });
}

/** Their local time now, from the first zone; the server's reading when the zone is unknown. */
export function localTimeNow(local: CallListRow["local"], now: Date): string | null {
  const zone = local.zones[0];
  return (zone ? zoneClock(zone, now)?.hhmm : null) ?? local.localTime;
}

/** A number that can be called now: it has one and it is inside their call window. */
export function canDial(
  row: Pick<CallListRow, "phone" | "local">,
  window: CallListResponse["window"],
  now: Date,
): boolean {
  return row.phone != null && inCallWindow(row.local.zones, window, now);
}

/** "calls at 09:00 their time", outside the window; null inside it. */
export function windowHint(
  row: Pick<CallListRow, "local">,
  window: CallListResponse["window"],
  now: Date,
): string | null {
  return inCallWindow(row.local.zones, window, now) ? null : `calls at ${window.start} their time`;
}

/**
 * Call was clicked: check the window once more on the clock as it is now.
 * Outside it, the tel: link is stopped and the page re-reads the clock.
 */
export function beginCall(
  e: { preventDefault: () => void },
  row: Pick<CallListRow, "phone" | "local">,
  window: CallListResponse["window"],
  handlers: { start: (phone: string | null) => void; refresh: () => void },
  now: Date = new Date(),
): boolean {
  if (canDial(row, window, now)) {
    // The number the link dials, as it reads now: the log names this one.
    handlers.start(row.phone);
    return true;
  }
  e.preventDefault();
  handlers.refresh();
  return false;
}

/** Which row: a person due in two plays has a Due row for each. */
export type RowKey = Pick<CallListRow, "prospectId" | "playName">;

export function sameRow(a: RowKey, b: RowKey): boolean {
  return a.prospectId === b.prospectId && (a.playName ?? null) === (b.playName ?? null);
}

/** A row as a string, for React keys and maps. */
export function rowId(row: RowKey): string {
  return `${row.prospectId}|${row.playName ?? ""}`;
}

/** The row after this one in its own section; null at the end. */
export function nextRow(rows: CallListRow[], row: RowKey): CallListRow | null {
  const i = rows.findIndex((r) => sameRow(r, row));
  return i === -1 ? null : (rows[i + 1] ?? null);
}

/** The section that holds this row. */
export function sectionRows(
  data: CallListResponse,
  row: Pick<CallListRow, "section">,
): CallListRow[] {
  return row.section === "due" ? data.due : data.list;
}

/**
 * The row to open: the Due row of this play when one is named (a cadence's
 * "Open call"), else the person's first row, Due first.
 */
export function findRow(
  data: CallListResponse,
  prospectId: number,
  playName?: string,
): CallListRow | null {
  const rows = [...data.due, ...data.list].filter((r) => r.prospectId === prospectId);
  return (playName ? rows.find((r) => r.playName === playName) : undefined) ?? rows[0] ?? null;
}

/** "4:07" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A week from today, as the date input reads it: seven calendar days, not 168 hours (a clock change sits between). */
export function defaultHoldUntil(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface DialState {
  outcome: CallOutcome | null;
  note: string;
  holdUntil: string;
}

export type DialAction =
  | { kind: "pick"; outcome: CallOutcome }
  | { kind: "note"; note: string }
  | { kind: "hold"; holdUntil: string };

export function dialReducer(state: DialState, action: DialAction): DialState {
  if (action.kind === "pick") return { ...state, outcome: action.outcome };
  if (action.kind === "note") return { ...state, note: action.note };
  return { ...state, holdUntil: action.holdUntil };
}

export interface DialKeyEvent {
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

function tagOf(
  target: EventTarget | null,
): { tag: string; editable: boolean; role: string | null } | null {
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  } | null;
  if (!el || typeof el.tagName !== "string") return null;
  return {
    tag: el.tagName,
    editable: el.isContentEditable === true,
    role: el.getAttribute?.("role") ?? null,
  };
}

function inEditable(target: EventTarget | null): boolean {
  const t = tagOf(target);
  if (!t) return false;
  return t.editable || t.tag === "INPUT" || t.tag === "TEXTAREA" || t.tag === "SELECT";
}

/** A control that does its own thing on Enter: a button, link, field or switch. */
function isInteractive(target: EventTarget | null): boolean {
  const t = tagOf(target);
  if (!t) return false;
  return (
    inEditable(target) ||
    t.tag === "BUTTON" ||
    t.tag === "A" ||
    t.tag === "SUMMARY" ||
    t.role === "button" ||
    t.role === "switch" ||
    t.role === "link"
  );
}

/**
 * A key on the dial panel: a digit picks its outcome, Enter saves and moves
 * on. Typing in the note keeps its keys, and a focused button or link keeps
 * its own Enter; ⌘/Ctrl+Enter saves from anywhere.
 */
export function dialKeyAction(e: DialKeyEvent): DialAction | { kind: "save" } | null {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return { kind: "save" };
  if (inEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Enter") return isInteractive(e.target) ? null : { kind: "save" };
  const hit = OUTCOME_KEYS.find((o) => o.key === e.key);
  return hit ? { kind: "pick", outcome: hit.outcome } : null;
}

/** The body Save posts: the note trimmed, the hold date only for Not now. */
export function logCallRequest(
  state: DialState,
  opts: {
    durationSec?: number | null;
    playName?: string | null;
    phone?: string | null;
    /** The row's `currentStep`: null on the call list, where no step is due. */
    currentStep?: number | null;
    enrolledAt?: string | null;
    clientKey?: string;
  },
): LogCallRequest | null {
  if (!state.outcome) return null;
  const note = state.note.trim();
  return {
    outcome: state.outcome,
    ...(note ? { note } : {}),
    ...(opts.durationSec != null ? { durationSec: Math.round(opts.durationSec) } : {}),
    ...(opts.playName ? { playName: opts.playName } : {}),
    ...(opts.phone ? { phone: opts.phone } : {}),
    ...(opts.currentStep !== undefined ? { currentStep: opts.currentStep } : {}),
    ...(opts.enrolledAt ? { enrolledAt: opts.enrolledAt } : {}),
    ...(opts.clientKey ? { clientKey: opts.clientKey } : {}),
    ...(state.outcome === "not_now" && state.holdUntil ? { holdUntil: state.holdUntil } : {}),
  };
}

/**
 * A new id for one save. `getRandomValues`, not `randomUUID`: the dashboard
 * may be served over plain http on a tailnet, where only the former exists.
 */
export function newSaveKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** When Call was pressed, for whom, and the number it dialled: the dial panel's timer. */
export interface CallTimer {
  prospectId: number;
  at: number;
  phone: string | null;
}

/**
 * The timer once a save finishes: spent when it is still the one the save
 * was submitted with. A newer one (Call pressed again while the save ran,
 * for the same person or another) is kept.
 */
export function timerAfterLog(
  timer: CallTimer | null,
  logged: { prospectId: number; at: number | null },
): CallTimer | null {
  return timer && timer.prospectId === logged.prospectId && timer.at === logged.at ? null : timer;
}

/** Each prospect's started call: a log spends only that prospect's (`timerAfterLog`). */
export function timersAfterLog(
  timers: Readonly<Record<number, CallTimer>>,
  logged: { prospectId: number; at: number | null },
): Record<number, CallTimer> {
  const timer = timers[logged.prospectId];
  if (!timer || timerAfterLog(timer, logged)) return timers as Record<number, CallTimer>;
  const rest = { ...timers };
  delete rest[logged.prospectId];
  return rest;
}
