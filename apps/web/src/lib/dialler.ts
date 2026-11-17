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

/** A number that can be called now: it has one and it is inside their call window. */
export function canDial(row: Pick<CallListRow, "phone" | "local">): boolean {
  return row.phone != null && row.local.inWindow;
}

/** "calls at 09:00 their time", outside the window; null inside it. */
export function windowHint(
  row: Pick<CallListRow, "local">,
  window: CallListResponse["window"],
): string | null {
  return row.local.inWindow ? null : `calls at ${window.start} their time`;
}

/** The row after this one in its own section; null at the end. */
export function nextRow(rows: CallListRow[], prospectId: number): CallListRow | null {
  const i = rows.findIndex((r) => r.prospectId === prospectId);
  return i === -1 ? null : (rows[i + 1] ?? null);
}

/** The section that holds this prospect, Due first. */
export function sectionRows(data: CallListResponse, prospectId: number): CallListRow[] {
  return data.due.some((r) => r.prospectId === prospectId) ? data.due : data.list;
}

export function findRow(data: CallListResponse, prospectId: number): CallListRow | null {
  return [...data.due, ...data.list].find((r) => r.prospectId === prospectId) ?? null;
}

/** "4:07" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A week from today, as the date input reads it. */
export function defaultHoldUntil(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
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

function inEditable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * A key on the dial panel: a digit picks its outcome, Enter saves and moves
 * on. Typing in the note keeps its keys; ⌘/Ctrl+Enter saves from there.
 */
export function dialKeyAction(e: DialKeyEvent): DialAction | { kind: "save" } | null {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return { kind: "save" };
  if (inEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Enter") return { kind: "save" };
  const hit = OUTCOME_KEYS.find((o) => o.key === e.key);
  return hit ? { kind: "pick", outcome: hit.outcome } : null;
}

/** The body Save posts: the note trimmed, the hold date only for Not now. */
export function logCallRequest(
  state: DialState,
  opts: { durationSec?: number | null; playName?: string | null },
): LogCallRequest | null {
  if (!state.outcome) return null;
  const note = state.note.trim();
  return {
    outcome: state.outcome,
    ...(note ? { note } : {}),
    ...(opts.durationSec != null ? { durationSec: Math.round(opts.durationSec) } : {}),
    ...(opts.playName ? { playName: opts.playName } : {}),
    ...(state.outcome === "not_now" && state.holdUntil ? { holdUntil: state.holdUntil } : {}),
  };
}
