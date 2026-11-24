/**
 * The dialler's records (migration v27): one `calls` row per call the founder
 * made or logged, the `channel_events` touch it leaves, and the brief written
 * for someone outside a cadence (`call_briefs`). What an outcome does to a
 * cadence lives in plays (`recordCall`, _calls.ts), which needs the sequence;
 * this module only reads and writes rows.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  REPLY_INTENTS,
  type CallBrief,
  type CallOutcome,
  type CallRecordView,
  type ReplyIntent,
} from "@oneshot-gtm/shared-types";
import {
  contactAllowedClause,
  contactAllowedSetClause,
  hasSharedPerson,
} from "./contact-optout.ts";
import { normalizePhone } from "./phone-timezone.ts";

/**
 * The reply label a call outcome counts as, where it means the same thing, so
 * replies and the funnel read a call like an email. Null for outcomes nobody
 * answered (no answer, voicemail, a gatekeeper, a wrong number).
 */
export function callReplyIntent(outcome: CallOutcome): ReplyIntent | null {
  switch (outcome) {
    case "interested":
      return "interested";
    case "meeting_booked":
      return "meeting";
    case "not_now":
      return "not_now";
    case "not_interested":
      return "not_interested";
    case "wrong_person":
      return "wrong_person";
    case "do_not_contact":
      return "unsubscribe";
    default:
      return null;
  }
}

/**
 * Outcomes that end the conversation as a reply: the call leaves a `reply`
 * channel event (every reply reader counts it) and stops the person's live
 * cadences. The rest leave a `call` event, a touch.
 */
export const CALL_REPLY_OUTCOMES: ReadonlySet<CallOutcome> = new Set([
  "interested",
  "meeting_booked",
  "not_interested",
  "do_not_contact",
]);

interface CallRow {
  id: number;
  prospect_id: number;
  play_name: string | null;
  started_at: string;
  duration_sec: number | null;
  outcome: string | null;
  reply_intent: string | null;
  note: string | null;
  phone: string | null;
  provider: string;
  provider_call_sid: string | null;
  client_key: string | null;
  recording_sid: string | null;
  transcript_status: string;
  transcript_json: string | null;
  summary_json: string | null;
  created_at: string;
  member: string | null;
  status: string | null;
  transcript_sid: string | null;
  status_reason: string | null;
  member_phone: string | null;
  bridged_at: string | null;
  commitments_json: string | null;
  discard_recording: number;
  recording_from?: string | null;
  recording_requested_at?: string | null;
  discard_next_at?: string | null;
  connected_at?: string | null;
  recording_paused?: number;
}

/** A bridged call's live states (`CallRecordView.status`). */
export const BRIDGE_CALL_STATUSES = [
  "ringing_founder",
  "ringing_prospect",
  "connected",
  "ended",
  "failed",
] as const;
export type BridgeCallStatus = (typeof BRIDGE_CALL_STATUSES)[number];

function bridgeStatusOf(value: string | null): BridgeCallStatus {
  return BRIDGE_CALL_STATUSES.find((s) => s === value) ?? "ringing_founder";
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toView(row: CallRow): CallRecordView {
  const status = row.transcript_status;
  const commitments = parseJson<unknown>(row.commitments_json);
  return {
    id: row.id,
    prospectId: row.prospect_id,
    playName: row.play_name,
    startedAt: row.started_at,
    durationSec: row.duration_sec,
    outcome: (row.outcome as CallOutcome | null) ?? null,
    note: row.note,
    member: row.member ?? null,
    provider: row.provider === "twilio" ? "twilio" : "tel",
    ...(row.provider === "twilio" ? { status: bridgeStatusOf(row.status) } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(Array.isArray(commitments)
      ? { commitments: commitments.filter((c): c is string => typeof c === "string") }
      : {}),
    ...(row.recording_from === "answer" || row.recording_from === "consent"
      ? { recordedFrom: row.recording_from }
      : {}),
    ...(row.connected_at ? { connectedAt: row.connected_at } : {}),
    ...(row.recording_paused === 1 ? { recordingPaused: true as const } : {}),
    // A consent recording starts when Record was pressed; one from the
    // answer starts when the call connected.
    ...(row.recording_from === "consent" && row.recording_requested_at
      ? { recordingSince: row.recording_requested_at }
      : row.recording_from === "answer" && row.connected_at
        ? { recordingSince: row.connected_at }
        : {}),
    ...(row.discard_recording === 1
      ? { discard: "pending" as const }
      : row.discard_recording === 2
        ? { discard: "done" as const }
        : {}),
    transcriptStatus:
      status === "pending" || status === "ready" || status === "failed" ? status : "none",
    transcript: parseJson<CallRecordView["transcript"]>(row.transcript_json),
    suggestion: parseJson<CallRecordView["suggestion"]>(row.summary_json),
  };
}

/** Write one call. Returns its id. */
export function insertCall(
  db: Database,
  input: {
    prospectId: number;
    playName?: string | null;
    startedAt: string;
    durationSec?: number | null;
    outcome?: CallOutcome | null;
    note?: string | null;
    phone?: string | null;
    provider?: "tel" | "twilio";
    providerCallSid?: string | null;
    /** The member who placed or logged it (email); null for the unlisted local owner. */
    member?: string | null;
    /** A bridged call's state when written. */
    status?: BridgeCallStatus | null;
    /** 'pending' for a bridged call that is recorded; 'none' otherwise. */
    transcriptStatus?: "none" | "pending";
    /** The member's phone a bridged call rang and dials from. */
    memberPhone?: string | null;
    statusReason?: string | null;
    commitments?: readonly string[] | null;
    /** The dashboard's id for this save (`callByClientKey`). */
    clientKey?: string | null;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO calls (prospect_id, play_name, started_at, duration_sec, outcome, reply_intent,
                          note, phone, provider, provider_call_sid, member, status, transcript_status,
                          member_phone, status_reason, commitments_json, client_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.prospectId,
      input.playName ?? null,
      input.startedAt,
      input.durationSec ?? null,
      input.outcome ?? null,
      input.outcome ? callReplyIntent(input.outcome) : null,
      input.note ?? null,
      input.phone ?? null,
      input.provider ?? "tel",
      input.providerCallSid ?? null,
      input.member ?? null,
      input.status ?? null,
      input.transcriptStatus ?? "none",
      input.memberPhone ?? null,
      input.statusReason ?? null,
      input.commitments ? JSON.stringify(input.commitments) : null,
      input.clientKey ?? null,
    );
  return Number(result.lastInsertRowid);
}

/** The call a save with this key already wrote, if any: a retried save logs on it. */
export function callByClientKey(db: Database, clientKey: string): CallRecordView | null {
  const row = db.query("SELECT * FROM calls WHERE client_key = ?").get(clientKey) as CallRow | null;
  return row ? toView(row) : null;
}

/**
 * The call step a logged call completed, brought up to a changed outcome:
 * its `metadata.outcome`, and `replied` for an outcome that counts as a
 * reply (unless the play already has a replied step, as
 * `markLatestStepReplied`), else back to `sent`: a call step is only ever
 * marked replied by its own call. Returns the step's play; null when the
 * call completed no step.
 */
export function updateCallStepEvent(
  db: Database,
  input: {
    prospectId: number;
    callId: number;
    outcome: CallOutcome;
    replied: boolean;
    repliedAt?: string | null;
  },
): string | null {
  const event = db
    .query(
      `SELECT id, play_name FROM sequence_events
        WHERE prospect_id = ? AND channel = 'call' AND json_valid(metadata_json)
          AND json_extract(metadata_json, '$.callId') = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(input.prospectId, input.callId) as { id: number; play_name: string } | null;
  if (!event) return null;
  db.prepare(
    "UPDATE sequence_events SET metadata_json = json_set(metadata_json, '$.outcome', ?) WHERE id = ?",
  ).run(input.outcome, event.id);
  if (input.replied) {
    db.prepare(
      `UPDATE sequence_events SET status = 'replied', replied_at = datetime(COALESCE(?, 'now'))
        WHERE id = ? AND status IN ('sent', 'delivered')
          AND NOT EXISTS (SELECT 1 FROM sequence_events
                           WHERE prospect_id = ? AND play_name = ? AND status = 'replied')`,
    ).run(input.repliedAt ?? null, event.id, input.prospectId, event.play_name);
  } else {
    db.prepare(
      "UPDATE sequence_events SET status = 'sent', replied_at = NULL WHERE id = ? AND status = 'replied'",
    ).run(event.id);
  }
  return event.play_name;
}

/**
 * Log the outcome on a call already written (a bridged call). False when no
 * such call is the prospect's, or when it was logged `do_not_contact`: the
 * person's opt-out is never logged over (it is what `contactAllowedClause`
 * reads), so only the same outcome again touches it.
 */
export function setCallOutcome(
  db: Database,
  input: {
    id: number;
    prospectId: number;
    outcome: CallOutcome;
    note?: string | null;
    durationSec?: number | null;
    playName?: string | null;
    /** The promises the member confirmed; absent keeps what is stored. */
    commitments?: readonly string[] | null;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE calls SET outcome = ?, reply_intent = ?, note = COALESCE(?, note),
                duration_sec = COALESCE(?, duration_sec), play_name = COALESCE(play_name, ?),
                commitments_json = CASE WHEN discard_recording <> 0 THEN NULL
                                        ELSE COALESCE(?, commitments_json) END
         WHERE id = ? AND prospect_id = ?
           AND (COALESCE(outcome, '') <> 'do_not_contact' OR ? = 'do_not_contact')`,
      )
      .run(
        input.outcome,
        callReplyIntent(input.outcome),
        input.note ?? null,
        input.durationSec ?? null,
        input.playName ?? null,
        input.commitments ? JSON.stringify(input.commitments) : null,
        input.id,
        input.prospectId,
        input.outcome,
      ).changes > 0
  );
}

/** What the bridge needs of a bridged call besides its view: the provider's ids. */
export interface BridgedCall {
  view: CallRecordView;
  callSid: string;
  recordingSid: string | null;
  transcriptSid: string | null;
  /** The number dialled, E.164. */
  phone: string | null;
  memberPhone: string | null;
  bridgedAt: string | null;
  /** The prospect declined recording: its recording and transcript are being deleted. */
  discardPending: boolean;
}

function toBridged(row: CallRow): BridgedCall | null {
  if (row.provider !== "twilio" || !row.provider_call_sid) return null;
  return {
    view: toView(row),
    callSid: row.provider_call_sid,
    recordingSid: row.recording_sid,
    transcriptSid: row.transcript_sid,
    phone: row.phone,
    memberPhone: row.member_phone,
    bridgedAt: row.bridged_at,
    discardPending: row.discard_recording === 1,
  };
}

/** A bridged call by id; null for a `tel:` call or none. */
export function getBridgedCall(db: Database, id: number): BridgedCall | null {
  const row = db.query("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | null;
  return row ? toBridged(row) : null;
}

/**
 * Write what the bridge read or did on a call. Each key present replaces the
 * stored value. The recording and transcript keys are dropped once the
 * prospect declined recording: a read in flight must not write them back.
 */
export function updateBridgedCall(
  db: Database,
  id: number,
  patch: {
    status?: BridgeCallStatus;
    statusReason?: string | null;
    durationSec?: number | null;
    recordingSid?: string | null;
    transcriptSid?: string | null;
    transcriptStatus?: CallRecordView["transcriptStatus"];
    transcript?: CallRecordView["transcript"];
    suggestion?: CallRecordView["suggestion"];
    /** The recording was asked for: how, and when (`recording_requested_at`). */
    recordingFrom?: "answer" | null;
    recordingRequestedAt?: string | null;
    /** Stop recording pressed (true) or Record pressed again (false). */
    recordingPaused?: boolean;
  },
): void {
  const write = (cols: Array<[string, string | number | null | undefined]>, where: string) => {
    const present = cols.filter((c): c is [string, string | number | null] => c[1] !== undefined);
    if (present.length === 0) return;
    db.prepare(
      `UPDATE calls SET ${present.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ? ${where}`,
    ).run(...present.map(([, v]) => v), id);
  };
  write(
    [
      ["status", patch.status],
      ["status_reason", patch.statusReason],
      ["duration_sec", patch.durationSec],
    ],
    // A late read of a live state never replaces an ended one.
    patch.status !== undefined && !TERMINAL_STATUSES.has(patch.status) ? LIVE_ONLY : "",
  );
  // The first read that finds it connected starts the call's clock, once.
  if (patch.status === "connected")
    db.prepare(
      `UPDATE calls SET connected_at = ? WHERE id = ? AND connected_at IS NULL ${LIVE_ONLY}`,
    ).run(new Date().toISOString(), id);
  write(
    [
      ["recording_sid", patch.recordingSid],
      ["recording_from", patch.recordingFrom],
      ["recording_requested_at", patch.recordingRequestedAt],
      [
        "recording_paused",
        patch.recordingPaused === undefined ? undefined : patch.recordingPaused ? 1 : 0,
      ],
      ["transcript_sid", patch.transcriptSid],
      ["transcript_status", patch.transcriptStatus],
      [
        "transcript_json",
        patch.transcript === undefined
          ? undefined
          : patch.transcript && JSON.stringify(patch.transcript),
      ],
      [
        "summary_json",
        patch.suggestion === undefined
          ? undefined
          : patch.suggestion && JSON.stringify(patch.suggestion),
      ],
    ],
    "AND discard_recording = 0",
  );
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["ended", "failed"]);

/** A call on the live bar, with who it is to. */
export interface LiveCallRow {
  view: CallRecordView;
  prospectName: string | null;
  prospectCompany: string | null;
}

/**
 * What the live bar is built from: every bridged call not over yet (started
 * since `liveSinceIso`), whoever placed it, then the member's own bridged
 * calls that ended since `sinceIso` with no outcome logged, newest first.
 */
export function listLiveCalls(
  db: Database,
  input: {
    /** Ended calls from this time on. */
    sinceIso: string;
    /** Live calls started from this time on: an older one still marked live is stale, not live. */
    liveSinceIso: string;
    /** Whose ended calls: the member's key (trimmed, lowercased email), "" for the unlisted owner. */
    endedMember: string;
    endedLimit?: number;
  },
): LiveCallRow[] {
  type Joined = CallRow & { p_name: string | null; p_company: string | null };
  const select = `SELECT c.*, p.name AS p_name, p.company AS p_company
                    FROM calls c LEFT JOIN prospects p ON p.id = c.prospect_id`;
  const live = db
    .query(
      `${select}
        WHERE c.provider = 'twilio' AND COALESCE(c.status, '') NOT IN ('ended', 'failed')
          AND c.started_at >= ?
        ORDER BY c.started_at DESC, c.id DESC`,
    )
    .all(input.liveSinceIso) as Joined[];
  const ended = db
    .query(
      `${select}
        WHERE c.provider = 'twilio' AND c.status = 'ended' AND c.outcome IS NULL
          AND c.started_at >= ?
          AND (CASE WHEN ? = '' THEN c.member IS NULL ELSE LOWER(TRIM(c.member)) = ? END)
        ORDER BY c.started_at DESC, c.id DESC
        LIMIT ?`,
    )
    .all(input.sinceIso, input.endedMember, input.endedMember, input.endedLimit ?? 3) as Joined[];
  return [...live, ...ended].map((r) => ({
    view: toView(r),
    prospectName: r.p_name,
    prospectCompany: r.p_company,
  }));
}
const LIVE_ONLY = "AND COALESCE(status, '') NOT IN ('ended', 'failed')";

/**
 * The member's leg as read before anyone was dialled: written only while no
 * poll has claimed the call (`claimBridge`), so a stale read never ends or
 * unrecords a call another poll has bridged.
 */
export function updateUnclaimedCall(
  db: Database,
  id: number,
  patch: { status: BridgeCallStatus; statusReason?: string; transcriptStatus?: "none" },
): void {
  const cols: Array<[string, string]> = [["status", patch.status]];
  if (patch.statusReason !== undefined) cols.push(["status_reason", patch.statusReason]);
  if (patch.transcriptStatus !== undefined)
    cols.push(["transcript_status", patch.transcriptStatus]);
  db.prepare(
    `UPDATE calls SET ${cols.map(([c]) => `${c} = ?`).join(", ")}
      WHERE id = ? AND bridged_at IS NULL
        ${TERMINAL_STATUSES.has(patch.status) ? "" : LIVE_ONLY}`,
  ).run(...cols.map(([, v]) => v), id);
}

/** Claim a held call for dialling the prospect: true for exactly one caller. */
export function claimBridge(db: Database, id: number, atIso: string): boolean {
  return (
    db.prepare("UPDATE calls SET bridged_at = ? WHERE id = ? AND bridged_at IS NULL").run(atIso, id)
      .changes === 1
  );
}

/**
 * The prospect declined recording: drop the transcript, the suggestion and
 * the promises read from it now, delete the provider's copies next.
 */
export function markRecordingDiscard(db: Database, id: number): void {
  db.prepare(
    `UPDATE calls SET discard_recording = 1, transcript_status = 'none', transcript_json = NULL,
            summary_json = NULL, commitments_json = NULL
      WHERE id = ? AND provider = 'twilio' AND discard_recording = 0`,
  ).run(id);
}

/** The member pressed Record (the prospect agreed): true for exactly one caller, on a call not yet recorded. */
export function claimRecording(db: Database, id: number, atIso: string): boolean {
  return (
    db
      .prepare(
        `UPDATE calls SET transcript_status = 'pending', recording_from = 'consent',
                recording_requested_at = ?
          WHERE id = ? AND provider = 'twilio' AND transcript_status = 'none'
            AND recording_sid IS NULL AND discard_recording = 0`,
      )
      .run(atIso, id).changes === 1
  );
}

/** A Record press Twilio refused for certain: nothing records, so Record can be pressed again. */
export function releaseRecording(db: Database, id: number): void {
  db.prepare(
    `UPDATE calls SET transcript_status = 'none', recording_from = NULL, recording_requested_at = NULL
      WHERE id = ? AND discard_recording = 0 AND recording_from = 'consent'`,
  ).run(id);
}

/** A pending deletion's next try: `nextIso`, behind deletions ready sooner. */
export function deferDiscard(db: Database, id: number, nextIso: string): void {
  db.prepare("UPDATE calls SET discard_next_at = ? WHERE id = ? AND discard_recording = 1").run(
    nextIso,
    id,
  );
}

/** The provider's recording and transcripts are deleted. */
export function finishRecordingDiscard(db: Database, id: number): void {
  db.prepare(
    `UPDATE calls SET discard_recording = 2, recording_sid = NULL, transcript_sid = NULL
      WHERE id = ? AND discard_recording = 1`,
  ).run(id);
}

/**
 * Bridged calls started since `sinceIso` with work left: still live as last
 * read, a transcript pending, or a ready transcript with no suggestion yet.
 * Oldest first, at most `limit` (the scheduler's sweep). A recording
 * deletion still pending is taken however old, up to `discardLimit` more,
 * so a long outage never leaves one behind and never crowds out new calls.
 */
export function listBridgedCallsToAdvance(
  db: Database,
  sinceIso: string,
  limit: number,
  discardLimit = 5,
  nowIso = new Date().toISOString(),
  /** Calls are off: only declined recordings are still worked. */
  onlyDiscards = false,
): BridgedCall[] {
  const discardDue = "discard_recording = 1 AND (discard_next_at IS NULL OR discard_next_at <= ?)";
  const work = onlyDiscards
    ? `COALESCE(status, '') NOT IN ('ended', 'failed') AND discard_recording = 1 OR (${discardDue})`
    : `COALESCE(status, '') NOT IN ('ended', 'failed')
               OR (${discardDue})
               OR (transcript_status = 'pending' AND discard_recording = 0)
               OR (transcript_status = 'ready' AND summary_json IS NULL
                   AND COALESCE(json_array_length(transcript_json), 0) > 0)`;
  const recent = db
    .query(
      `SELECT * FROM calls
        WHERE provider = 'twilio' AND provider_call_sid IS NOT NULL AND started_at >= ?
          AND (${work})
        ORDER BY started_at ASC, id ASC LIMIT ?`,
    )
    .all(sinceIso, nowIso, limit) as CallRow[];
  // Ready soonest first: one that keeps failing is pushed behind the rest.
  const oldDiscards = db
    .query(
      `SELECT * FROM calls
        WHERE provider = 'twilio' AND provider_call_sid IS NOT NULL AND started_at < ?
          AND ${discardDue}
        ORDER BY COALESCE(discard_next_at, started_at) ASC, id ASC LIMIT ?`,
    )
    .all(sinceIso, nowIso, discardLimit) as CallRow[];
  return [...oldDiscards, ...recent].map(toBridged).filter((c): c is BridgedCall => c != null);
}

/**
 * Bridged calls whose recording was asked for (else started) before
 * `beforeIso` and whose transcript is still pending: the sweep gives up on them (`transcript_status = 'failed'`). Returns how
 * many it marked.
 */
export function failStaleTranscripts(db: Database, beforeIso: string): number {
  return db
    .prepare(
      `UPDATE calls SET transcript_status = 'failed'
        WHERE provider = 'twilio' AND transcript_status = 'pending'
          AND COALESCE(recording_requested_at, started_at) < ?`,
    )
    .run(beforeIso).changes;
}

export function getCall(db: Database, id: number): CallRecordView | null {
  const row = db.query("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | null;
  return row ? toView(row) : null;
}

/** A prospect's calls, newest first. */
export function listCallsForProspect(db: Database, prospectId: number): CallRecordView[] {
  return (
    db
      .query("SELECT * FROM calls WHERE prospect_id = ? ORDER BY started_at DESC, id DESC")
      .all(prospectId) as CallRow[]
  ).map(toView);
}

/** The newest call of each prospect, keyed by prospect id. */
export function lastCallsFor(
  db: Database,
  prospectIds: readonly number[],
): Map<number, { outcome: CallOutcome | null; at: string }> {
  const out = new Map<number, { outcome: CallOutcome | null; at: string }>();
  for (let i = 0; i < prospectIds.length; i += 400) {
    const ids = prospectIds.slice(i, i + 400);
    if (ids.length === 0) continue;
    const rows = db
      .query(
        `SELECT c.prospect_id, c.outcome, c.started_at FROM calls c
          WHERE c.prospect_id IN (${ids.map(() => "?").join(",")})
            AND c.id = (SELECT c2.id FROM calls c2 WHERE c2.prospect_id = c.prospect_id
                         ORDER BY c2.started_at DESC, c2.id DESC LIMIT 1)`,
      )
      .all(...ids) as Array<{ prospect_id: number; outcome: string | null; started_at: string }>;
    for (const r of rows)
      out.set(r.prospect_id, {
        outcome: (r.outcome as CallOutcome | null) ?? null,
        at: r.started_at,
      });
  }
  return out;
}

/**
 * The touch a logged call leaves in `channel_events` (channel `call`):
 * `reply` for an outcome in `CALL_REPLY_OUTCOMES`, else `call`. Keyed on a
 * hash of the call id, so logging the same call twice writes one row; a
 * changed outcome (a bridged call first logged no_answer, then interested)
 * rewrites that row's type and keeps when it happened.
 */
export function recordCallChannelEvent(
  db: Database,
  input: { callId: number; prospectId: number; outcome: CallOutcome; occurredAt: string },
): void {
  const externalId = createHash("sha256").update(`call:${input.callId}`).digest("hex").slice(0, 32);
  db.prepare(
    `INSERT INTO channel_events
       (source, external_event_id, prospect_id, channel, event_type, occurred_at)
     VALUES ('call', ?, ?, 'call', ?, ?)
     ON CONFLICT(source, external_event_id) DO UPDATE SET event_type = excluded.event_type`,
  ).run(
    externalId,
    input.prospectId,
    CALL_REPLY_OUTCOMES.has(input.outcome) ? "reply" : "call",
    input.occurredAt,
  );
}

/**
 * Clear a number that rang the wrong person; the call row keeps it. Only
 * when the prospect's stored number is still that one (compared as E.164):
 * a replacement found since, or a late log of an older call, is kept. True
 * when it cleared.
 */
export function clearProspectPhone(
  db: Database,
  prospectId: number,
  wrongPhone: string | null,
  defaultCountry = "US",
): boolean {
  const wrong = normalizePhone(wrongPhone, defaultCountry);
  if (!wrong) return false;
  const row = db.query("SELECT phone FROM prospects WHERE id = ?").get(prospectId) as {
    phone: string | null;
  } | null;
  if (!row?.phone || normalizePhone(row.phone, defaultCountry) !== wrong) return false;
  // Only the number just read: a replacement saved since then is kept.
  return (
    db
      .prepare("UPDATE prospects SET phone = NULL WHERE id = ? AND phone = ?")
      .run(prospectId, row.phone).changes > 0
  );
}

/** The number a call dialled, as stored on it; null when none. */
export function callPhone(db: Database, callId: number): string | null {
  const row = db.query("SELECT phone FROM calls WHERE id = ?").get(callId) as {
    phone: string | null;
  } | null;
  return row?.phone ?? null;
}

/**
 * A queue row's address (alias `q`), lowercased: its `email`, else the
 * `founderEmail` a founder-targeting play (show-hn) writes instead.
 */
const QUEUE_ADDRESS = `lower(trim(COALESCE(NULLIF(trim(json_extract(q.payload_json, '$.email')), ''),
                                      json_extract(q.payload_json, '$.founderEmail'))))`;

/**
 * Every number stored for a prospect, as written: their own `phone`, then the
 * newest queue row's `payload.phone` (where a phone lookup writes it), matched
 * by prospect, else by the prospect's email. Also the newest queue row, for
 * the Find phone button. `phoneForCall` (plays) normalises these. The
 * address is the payload's `email`, else its `founderEmail` (`QUEUE_ADDRESS`).
 */
export function phoneSourcesFor(
  db: Database,
  prospectId: number,
): { prospectPhone: string | null; queuePhone: string | null; queueId: number | null } {
  const p = db.query("SELECT phone, email FROM prospects WHERE id = ?").get(prospectId) as {
    phone: string | null;
    email: string | null;
  } | null;
  if (!p) return { prospectPhone: null, queuePhone: null, queueId: null };
  const byProspect = queuePhoneRow(db, "q.prospect_id = ?", prospectId);
  const row =
    byProspect.queueId != null || !p.email?.trim()
      ? byProspect
      : queuePhoneRow(
          db,
          `q.prospect_id IS NULL AND json_valid(q.payload_json) AND ${QUEUE_ADDRESS} = lower(?)`,
          p.email.trim(),
        );
  return { prospectPhone: p.phone?.trim() || null, ...row };
}

/**
 * The number to call a prospect on, E.164: their own `phone` when it parses,
 * else the newest queue row's `payload.phone`. National numbers read as
 * `defaultCountry` (`defaultPhoneCountry`). A number a call was logged
 * `wrong_number` on is never offered again. Null when none is left. `raw`
 * is the stored text the number came from; `queueId` the newest queue row.
 */
export function phoneForCall(
  db: Database,
  prospectId: number,
  defaultCountry = "US",
): { phone: string | null; raw: string | null; queueId: number | null } {
  return pickCallPhone(
    phoneSourcesFor(db, prospectId),
    wrongNumbersFor(db, [prospectId], defaultCountry).get(prospectId),
    defaultCountry,
  );
}

/** `phoneForCall` on sources already read (the Calls page reads them in one query). */
export function pickCallPhone(
  sources: { prospectPhone: string | null; queuePhone: string | null; queueId: number | null },
  wrong: ReadonlySet<string> | undefined,
  defaultCountry = "US",
): { phone: string | null; raw: string | null; queueId: number | null } {
  for (const raw of [sources.prospectPhone, sources.queuePhone]) {
    const phone = normalizePhone(raw, defaultCountry);
    if (phone && !wrong?.has(phone)) return { phone, raw, queueId: sources.queueId };
  }
  return { phone: null, raw: null, queueId: sources.queueId };
}

/**
 * Numbers a call was logged `wrong_number` on, per prospect, normalised as
 * `pickCallPhone` compares them: on the prospect's row or on any other row
 * of their shared person here.
 */
export function wrongNumbersFor(
  db: Database,
  prospectIds: readonly number[],
  defaultCountry = "US",
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const samePerson = hasSharedPerson(db)
    ? ` OR c.prospect_id IN (SELECT o.id FROM prospects o WHERE o.shared_person_id = p.shared_person_id)`
    : "";
  for (let i = 0; i < prospectIds.length; i += 400) {
    const ids = prospectIds.slice(i, i + 400);
    if (ids.length === 0) continue;
    const rows = db
      .query(
        `SELECT p.id AS prospect_id, c.phone FROM prospects p
           JOIN calls c ON c.prospect_id = p.id${samePerson}
          WHERE p.id IN (${ids.map(() => "?").join(",")})
            AND c.outcome = 'wrong_number' AND c.phone IS NOT NULL`,
      )
      .all(...ids) as Array<{ prospect_id: number; phone: string }>;
    for (const r of rows) {
      const set = out.get(r.prospect_id) ?? new Set<string>();
      set.add(normalizePhone(r.phone, defaultCountry) ?? r.phone);
      out.set(r.prospect_id, set);
    }
  }
  return out;
}

function queuePhoneRow(
  db: Database,
  where: string,
  arg: string | number,
): { queuePhone: string | null; queueId: number | null } {
  const newest = db
    .query(`SELECT q.id FROM target_queue q WHERE ${where} ORDER BY q.id DESC LIMIT 1`)
    .get(arg) as { id: number } | null;
  const phone = db
    .query(
      `SELECT json_extract(q.payload_json, '$.phone') AS phone FROM target_queue q
        WHERE ${where} AND json_valid(q.payload_json)
          AND trim(COALESCE(json_extract(q.payload_json, '$.phone'), '')) <> ''
        ORDER BY q.id DESC LIMIT 1`,
    )
    .get(arg) as { phone: unknown } | null;
  return {
    queuePhone: typeof phone?.phone === "string" ? phone.phone.trim() : null,
    queueId: newest?.id ?? null,
  };
}

/**
 * The brief cached for a prospect outside a cadence, or null. `offerKey`
 * names the offer it was written under (stored with the brief; null for
 * none, or a brief stored before it was kept): the caller writes a new one
 * when the offer changed since.
 */
export function getCallBrief(
  db: Database,
  prospectId: number,
): { brief: CallBrief; playName: string | null; briefAt: string; offerKey: string | null } | null {
  const row = db
    .query("SELECT brief_json, play_name, brief_at FROM call_briefs WHERE prospect_id = ?")
    .get(prospectId) as { brief_json: string; play_name: string | null; brief_at: string } | null;
  const stored = row ? parseJson<CallBrief & { offerKey?: unknown }>(row.brief_json) : null;
  if (!row || !stored) return null;
  const { offerKey, ...brief } = stored;
  return {
    brief,
    playName: row.play_name,
    briefAt: row.brief_at,
    offerKey: typeof offerKey === "string" ? offerKey : null,
  };
}

export function saveCallBrief(
  db: Database,
  input: {
    prospectId: number;
    playName: string | null;
    brief: CallBrief;
    /** The offer it was written under (`getCallBrief`). */
    offerKey?: string | null;
  },
): void {
  const json = JSON.stringify(
    input.offerKey ? { ...input.brief, offerKey: input.offerKey } : input.brief,
  );
  db.prepare(
    `INSERT INTO call_briefs (prospect_id, play_name, brief_json, brief_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(prospect_id) DO UPDATE SET play_name = excluded.play_name,
       brief_json = excluded.brief_json, brief_at = excluded.brief_at`,
  ).run(input.prospectId, input.playName, json, new Date().toISOString());
}

/** Why a Calls-page row ranks where it does: 1 replied positively, 2 connected on LinkedIn, 3 in a live cadence, 4 the rest. */
export type CallTier = 1 | 2 | 3 | 4;

/** One person the Calls page may list, before the do-not-contact and phone checks. */
export interface CallCandidate {
  prospectId: number;
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  prospectPhone: string | null;
  queuePhone: string | null;
  queueId: number | null;
  tier: CallTier;
  /** The reply label behind tier 1. */
  replyIntent: string | null;
  /** The live cadence's queue-row priority score (shadow score, 0-100), when tier 3. */
  priority: number | null;
  /** Its play, when tier 3. */
  playName: string | null;
  lastTouchAt: string | null;
}

const POSITIVE_INTENTS = REPLY_INTENTS.filter((i) => i.polarity === "positive").map((i) => i.label);
/** Labels that say where a person stands: a neutral one (an auto-reply, "not now") leaves it as it was. */
const DECIDING_INTENTS = REPLY_INTENTS.filter((i) => i.polarity !== "neutral").map((i) => i.label);
const sqlList = (labels: readonly string[]) =>
  labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(",");

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/**
 * The gates past the opt-outs that every Calls-page row passes, as SQL over
 * the prospect alias `p`: not rejected off-ICP, no meeting held, no cadence
 * stopped as do-not-contact. Shared by the call list and the due rows.
 */
function callGatesSql(db: Database): string {
  const meetingHeld = hasTable(db, "meetings")
    ? `EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id AND m.outcome = 'held')`
    : "0";
  return `COALESCE(p.icp_verdict, '') <> 'reject'
            AND NOT (${meetingHeld})
            AND NOT EXISTS (SELECT 1 FROM cadence_state dnc WHERE dnc.prospect_id = p.id
                             AND dnc.status = 'stopped' AND dnc.stop_reason = 'do_not_contact')`;
}

/**
 * Everyone with a number the Calls page may list, best first, capped at
 * `limit`. The gates run in SQL over sets (`contactAllowedSetClause`): the
 * per-prospect clause took minutes on a real ledger. A bounced email does not
 * block a call, since the number is a different address. The company
 * do-not-contact list is config, so the caller applies it. Ranking is in
 * docs/calls.md.
 */
export function listCallCandidates(
  db: Database,
  opts: {
    limit: number;
    /** Rows of the ranked list to skip: the Calls page pages through it. */
    offset?: number;
    excludeProspectIds?: readonly number[];
  },
): CallCandidate[] {
  const meetingAny = hasTable(db, "meetings")
    ? // A meeting booked: neither cancelled on the calendar (the event
      // status) nor logged cancelled or a no-show.
      `EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id
                 AND COALESCE(m.status, '') <> 'cancelled'
                 AND COALESCE(m.outcome, '') NOT IN ('cancelled', 'no_show'))`
    : "0";
  // The person's latest positive or negative answer, by email or on a call,
  // when it is positive: "not interested" after "interested" drops them out
  // of tier 1. Both reads are index seeks on (prospect_id, time).
  const deciding = sqlList(DECIDING_INTENTS);
  const positiveIntent = `(SELECT CASE WHEN r.intent IN (${sqlList(POSITIVE_INTENTS)}) THEN r.intent END FROM (
        SELECT ir.intent AS intent, julianday(ir.received_at) AS t FROM inbox_replies ir
         WHERE ir.prospect_id = p.id AND ir.intent IN (${deciding})
        UNION ALL
        SELECT cl.reply_intent, julianday(cl.started_at) FROM calls cl
         WHERE cl.prospect_id = p.id AND cl.reply_intent IN (${deciding})) r
      ORDER BY r.t DESC LIMIT 1)`;
  const noMeeting = `NOT EXISTS (SELECT 1 FROM deal_outcomes d WHERE d.prospect_id = p.id AND d.outcome = 'meeting_booked')
      AND NOT (${meetingAny})`;
  const linkedInConnected = `EXISTS (
      SELECT 1 FROM sequence_events se
       WHERE se.prospect_id = p.id AND se.channel = 'linkedin' AND json_valid(se.metadata_json)
         AND (json_extract(se.metadata_json, '$.acceptedAt') IS NOT NULL
              OR json_extract(se.metadata_json, '$.inviteStatus') = 'already_connected'
              OR json_extract(se.metadata_json, '$.via') = 'profile-read'))`;
  const exclude = opts.excludeProspectIds ?? [];
  const excludeSql =
    exclude.length > 0
      ? `AND p.id NOT IN (${exclude.map((id) => Math.trunc(Number(id))).join(",")})`
      : "";
  const rows = db
    .query(
      `WITH
       -- Queue rows not linked to any prospect yet, by their address, as
       -- phoneSourcesFor reads them: the newest row (the Find phone button's)
       -- and the newest with a phone. target_queue's JSON is read once here,
       -- never once per prospect.
       -- Each payload is parsed once (materialised): the address is
       -- QUEUE_ADDRESS, from these two fields.
       mail_raw AS MATERIALIZED (
         SELECT q.id, json_extract(q.payload_json, '$.email') AS e,
                json_extract(q.payload_json, '$.founderEmail') AS f,
                json_extract(q.payload_json, '$.phone') AS ph
           FROM target_queue q
          WHERE q.prospect_id IS NULL AND json_valid(q.payload_json)),
       mail_queue AS MATERIALIZED (
         SELECT lower(trim(COALESCE(NULLIF(trim(e), ''), f))) AS email, MAX(id) AS id,
                MAX(CASE WHEN trim(COALESCE(ph, '')) <> '' THEN id END) AS phone_id
           FROM mail_raw
          WHERE COALESCE(NULLIF(trim(e), ''), trim(f), '') <> ''
          GROUP BY 1),
       mail_phone AS MATERIALIZED (
         SELECT m.email, m.id, trim(json_extract(q.payload_json, '$.phone')) AS phone
           FROM mail_queue m LEFT JOIN target_queue q ON q.id = m.phone_id),
       linked AS (
         SELECT p.id AS prospect_id, p.name, p.title, p.company, p.email,
                NULLIF(trim(COALESCE(p.phone, '')), '') AS prospect_phone,
                (SELECT q.id FROM target_queue q WHERE q.prospect_id = p.id
                  ORDER BY q.id DESC LIMIT 1) AS linked_queue_id,
                (SELECT trim(json_extract(q.payload_json, '$.phone')) FROM target_queue q
                  WHERE q.prospect_id = p.id AND json_valid(q.payload_json)
                    AND trim(COALESCE(json_extract(q.payload_json, '$.phone'), '')) <> ''
                  ORDER BY q.id DESC LIMIT 1) AS linked_queue_phone,
                ${positiveIntent} AS positive_intent,
                (${noMeeting}) AS no_meeting,
                (${linkedInConnected}) AS linkedin_connected,
                (SELECT c.play_name FROM cadence_state c WHERE c.prospect_id = p.id AND c.status = 'active'
                  ORDER BY c.enrolled_at DESC LIMIT 1) AS active_play,
                (SELECT MAX(json_extract(q.priority_json, '$.total')) FROM cadence_state c
                   JOIN target_queue q ON q.id = c.queue_id
                  WHERE c.prospect_id = p.id AND c.status = 'active' AND json_valid(q.priority_json)) AS priority,
                (SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(t)) FROM (
                   SELECT MAX(julianday(se.created_at)) AS t FROM sequence_events se
                    WHERE se.prospect_id = p.id AND se.status IN ('sent','delivered','replied')
                   UNION ALL SELECT MAX(julianday(ce.occurred_at)) FROM channel_events ce WHERE ce.prospect_id = p.id
                   UNION ALL SELECT MAX(julianday(cl.started_at)) FROM calls cl WHERE cl.prospect_id = p.id)) AS last_touch
           FROM prospects p
          WHERE (NULLIF(trim(COALESCE(p.phone, '')), '') IS NOT NULL OR p.id IN (
                  SELECT q.prospect_id FROM target_queue q
                   WHERE q.prospect_id IS NOT NULL AND json_valid(q.payload_json)
                     AND trim(COALESCE(json_extract(q.payload_json, '$.phone'), '')) <> '')
                 OR lower(trim(p.email)) IN (SELECT email FROM mail_phone WHERE phone IS NOT NULL))
            AND ${contactAllowedSetClause(db)}
            AND ${callGatesSql(db)}
            ${excludeSql}
       ),
       base AS (
         -- A queue row linked to the prospect wins; the address match only
         -- stands in when there is none (phoneSourcesFor's order).
         SELECT l.*,
                COALESCE(l.linked_queue_id, mp.id) AS queue_id,
                CASE WHEN l.linked_queue_id IS NOT NULL THEN l.linked_queue_phone
                     ELSE mp.phone END AS queue_phone
           FROM linked l LEFT JOIN mail_phone mp ON mp.email = lower(trim(l.email))
       )
       SELECT *,
              CASE WHEN positive_intent IS NOT NULL AND no_meeting THEN 1
                   WHEN linkedin_connected THEN 2
                   WHEN active_play IS NOT NULL THEN 3
                   ELSE 4 END AS tier
         FROM base
        WHERE prospect_phone IS NOT NULL OR queue_phone IS NOT NULL
        ORDER BY tier ASC, COALESCE(priority, -1) DESC, last_touch IS NULL, last_touch DESC, prospect_id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(opts.limit, Math.max(0, Math.trunc(opts.offset ?? 0))) as Array<{
    prospect_id: number;
    name: string | null;
    title: string | null;
    company: string | null;
    email: string | null;
    prospect_phone: string | null;
    queue_phone: string | null;
    queue_id: number | null;
    positive_intent: string | null;
    active_play: string | null;
    priority: number | null;
    last_touch: string | null;
    tier: number;
  }>;
  return rows.map((r) => ({
    prospectId: r.prospect_id,
    name: r.name,
    title: r.title,
    company: r.company,
    email: r.email,
    prospectPhone: r.prospect_phone,
    queuePhone: r.queue_phone,
    queueId: r.queue_id,
    tier: (r.tier >= 1 && r.tier <= 4 ? r.tier : 4) as CallTier,
    replyIntent: r.tier === 1 ? r.positive_intent : null,
    priority: typeof r.priority === "number" ? r.priority : null,
    playName: r.active_play,
    lastTouchAt: r.last_touch ? sqliteToIso(r.last_touch) : null,
  }));
}

/** "2026-11-17 10:00:00" (SQLite) or an ISO string, as ISO. */
function sqliteToIso(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(" ", "T")}Z`;
  return value;
}

/**
 * The live gates the Calls page applies to one prospect (a due call step),
 * the same as `listCallCandidates`': contact allowed, then `callGatesSql`.
 * False when any refuses.
 */
export function callAllowed(db: Database, prospectId: number): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM prospects p
          WHERE p.id = ? AND ${contactAllowedClause(db)} AND ${callGatesSql(db)}`,
      )
      .get(prospectId) != null
  );
}

/** `callAllowed` for many prospects at once (the Calls page's due rows): the ones allowed. */
export function callAllowedIds(db: Database, prospectIds: readonly number[]): Set<number> {
  const out = new Set<number>();
  const gates = `${contactAllowedSetClause(db)} AND ${callGatesSql(db)}`;
  for (let i = 0; i < prospectIds.length; i += 400) {
    const ids = prospectIds.slice(i, i + 400);
    if (ids.length === 0) continue;
    const rows = db
      .query(
        `SELECT p.id FROM prospects p
          WHERE p.id IN (${ids.map(() => "?").join(",")}) AND ${gates}`,
      )
      .all(...ids) as Array<{ id: number }>;
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** The last touch on any channel for these prospects (sends, channel events, calls), ISO. */
export function lastTouchFor(db: Database, prospectIds: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < prospectIds.length; i += 400) {
    const ids = prospectIds.slice(i, i + 400);
    if (ids.length === 0) continue;
    const marks = ids.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT prospect_id, strftime('%Y-%m-%dT%H:%M:%SZ', MAX(t)) AS t FROM (
           SELECT prospect_id, julianday(created_at) AS t FROM sequence_events
            WHERE prospect_id IN (${marks}) AND status IN ('sent','delivered','replied')
           UNION ALL SELECT prospect_id, julianday(occurred_at) FROM channel_events
            WHERE prospect_id IN (${marks})
           UNION ALL SELECT prospect_id, julianday(started_at) FROM calls WHERE prospect_id IN (${marks}))
         GROUP BY prospect_id`,
      )
      .all(...ids, ...ids, ...ids) as Array<{ prospect_id: number; t: string | null }>;
    for (const r of rows) if (r.t) out.set(r.prospect_id, sqliteToIso(r.t));
  }
  return out;
}
