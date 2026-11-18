/**
 * The dialler: the founder calls prospects from the dashboard. A cadence can
 * carry a call step (never run unattended), and the Calls page lists everyone
 * in the workspace with a number. Outcomes reuse the reply labels where they
 * mean the same thing, so replies and the funnel count a call like an email.
 */

/** What the founder logs after a call. */
export const CALL_OUTCOMES = [
  { outcome: "no_answer", title: "No answer", advances: true, stops: false },
  { outcome: "voicemail", title: "Left voicemail", advances: true, stops: false },
  { outcome: "gatekeeper", title: "Gatekeeper", advances: true, stops: false },
  { outcome: "wrong_person", title: "Wrong person", advances: true, stops: false },
  { outcome: "wrong_number", title: "Wrong number", advances: true, stops: false },
  { outcome: "interested", title: "Interested", advances: false, stops: true },
  { outcome: "meeting_booked", title: "Meeting booked", advances: false, stops: true },
  { outcome: "not_now", title: "Not now", advances: false, stops: false },
  { outcome: "not_interested", title: "Not interested", advances: false, stops: true },
  { outcome: "do_not_contact", title: "Do not contact", advances: false, stops: true },
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number]["outcome"];

export function isCallOutcome(value: unknown): value is CallOutcome {
  return CALL_OUTCOMES.some((o) => o.outcome === value);
}

/** What the founder reads before and during a call. Advisory: flags warn, never block. */
export interface CallBrief {
  /** Who you are and why you're calling, pointing back to the email. */
  opener: string;
  /** The offer, one plain sentence. */
  offer: string;
  questions: string[];
  objections: { objection: string; answer: string }[];
  /** At most ~20 seconds spoken. */
  voicemail: string;
  /** Who to ask for when the number is a main line; null when it is a direct number. */
  gatekeeper: string | null;
  /** Writing lint flags on the brief text (advisory). */
  flags?: string[];
}

/** The prospect's local clock, from their number. */
export interface CallLocalTime {
  /** IANA zones the number may be in; empty when unknown. */
  zones: string[];
  /** "14:05" in the first zone; null when unknown. */
  localTime: string | null;
  /** True when it is inside the workspace's call window in every zone (true when unknown). */
  inWindow: boolean;
  /** ISO time the window next opens, when outside it; null when its zones never share an opening. */
  opensAt: string | null;
}

/** One row on the Calls page. */
export interface CallListRow {
  prospectId: number;
  name: string | null;
  title: string | null;
  company: string | null;
  /** E.164, or null when no usable number (the row then offers Find phone). */
  phone: string | null;
  /** The prospect's queue row, for #1034's Find phone button; null when none. */
  queueId: number | null;
  local: CallLocalTime;
  /** The cadence this call belongs to, when it is a due call step. */
  playName: string | null;
  /** That cadence's `current_step` when the row was read: a log completes only this step. Null on the call list. */
  currentStep: number | null;
  /** That cadence's enrolment (`enrolled_at`) when the row was read; null on the call list. */
  enrolledAt: string | null;
  /** "due" = a cadence call step is due now; "list" = anyone else with a number. */
  section: "due" | "list";
  /** Why this row ranks where it does ("replied: interested", "LinkedIn connected", …). */
  reason: string;
  /** ISO of the last touch on any channel; null when none. */
  lastTouchAt: string | null;
  lastCall: { outcome: CallOutcome | null; at: string } | null;
}

export interface CallListResponse {
  enabled: boolean;
  /** Whether "Call" rings the founder's phone (bridge configured) or is a tel: link. */
  dialMode: "tel" | "bridge";
  window: { start: string; end: string; weekdays: boolean };
  due: CallListRow[];
  list: CallListRow[];
}

/** A logged call (the `calls` table). */
export interface CallRecordView {
  id: number;
  prospectId: number;
  playName: string | null;
  /** The member who placed or logged it (email); null for the install's unlisted local owner. */
  member: string | null;
  startedAt: string;
  durationSec: number | null;
  outcome: CallOutcome | null;
  note: string | null;
  provider: "tel" | "twilio";
  /** Phase 2: the bridged call's live state. */
  status?: "ringing_founder" | "ringing_prospect" | "connected" | "ended" | "failed";
  /** Why a bridged call failed or ended early, in plain words ("it went to your voicemail"). */
  statusReason?: string;
  /** The promises the member confirmed when logging it (`LogCallRequest.commitments`). */
  commitments?: string[];
  /** A bridged call's recording: from the prospect's answer, or from the member's Record press. */
  recordedFrom?: "answer" | "consent";
  /** A recording the prospect declined: still being deleted, or deleted. */
  discard?: "pending" | "done";
  transcriptStatus: "none" | "pending" | "ready" | "failed";
  transcript: { speaker: "founder" | "prospect"; text: string; startSec: number }[] | null;
  /** Phase 2: the model's proposal from the transcript; the founder confirms it. */
  suggestion: {
    outcome: CallOutcome;
    note: string;
    commitments: string[];
  } | null;
}

/** POST /api/prospects/:id/call */
export interface LogCallRequest {
  outcome: CallOutcome;
  note?: string;
  durationSec?: number;
  /** An existing `calls` row (a bridged call) to log against; a new row otherwise. */
  callId?: number;
  playName?: string;
  /** For `not_now`: ISO date the cadence resumes. */
  holdUntil?: string;
  /** The number the founder dialled (a new call): a wrong_number lands on it, not on a number stored since. */
  phone?: string;
  /** A bridged call: the suggested promises the member kept when saving. */
  commitments?: string[];
  /**
   * The step `playName`'s cadence was on when the row was opened: the call
   * completes that step only while it is still current. Null: no step was
   * due then, so none is completed. Absent: whichever call step is next.
   */
  currentStep?: number | null;
  /** The enrolment that step belongs to: a log after a stop and re-enrol completes nothing. */
  enrolledAt?: string;
  /** The dashboard's id for this save, the same on a retry: the server writes one call for it. */
  clientKey?: string;
}

/**
 * Whether bridged calls are recorded (`calls.bridge.record`). "ask": only
 * once the member presses Record, after the prospect agreed. "always": from
 * the prospect's answer, for places where one party's consent is enough.
 * false: never.
 */
export type CallRecordMode = "ask" | "always" | false;

/**
 * A member's own phone for bridged calls. It rings first, and the prospect
 * sees it as the caller ID, so a callback reaches the person who called.
 * Kept install-wide (shared database), so every workspace uses it.
 */
export interface MemberPhoneView {
  /** E.164; null when none is set. */
  phone: string | null;
  /** "verifying": the provider is ringing the phone with `validationCode` to type. */
  status: "none" | "verifying" | "verified" | "failed";
  /** While verifying: the 6-digit code the member types when the phone rings. */
  validationCode: string | null;
  verifiedAt: string | null;
  /** Why the last verification failed, in plain words. */
  error: string | null;
}

/** GET /api/calls/me: what this member's Call button can do. */
export interface CallsMeResponse {
  /** The provider keys are in the workspace's `.env`. */
  bridgeReady: boolean;
  phone: MemberPhoneView;
  /** How bridged calls are recorded (calls.bridge.record, default "ask"). */
  record: CallRecordMode;
}

/** POST /api/calls/me/phone: start verifying this number (answers with the code). */
export interface VerifyPhoneRequest {
  phone: string;
}

/** POST /api/calls/start */
export interface StartCallRequest {
  prospectId: number;
  playName?: string;
}
