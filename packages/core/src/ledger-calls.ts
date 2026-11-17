/**
 * The dialler's records (migration v25): one `calls` row per call the founder
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
import { contactAllowedClause, contactAllowedSetClause } from "./contact-optout.ts";
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
  recording_sid: string | null;
  transcript_status: string;
  transcript_json: string | null;
  summary_json: string | null;
  created_at: string;
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
  return {
    id: row.id,
    prospectId: row.prospect_id,
    playName: row.play_name,
    startedAt: row.started_at,
    durationSec: row.duration_sec,
    outcome: (row.outcome as CallOutcome | null) ?? null,
    note: row.note,
    provider: row.provider === "twilio" ? "twilio" : "tel",
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
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO calls (prospect_id, play_name, started_at, duration_sec, outcome, reply_intent,
                          note, phone, provider, provider_call_sid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  return Number(result.lastInsertRowid);
}

/** Log the outcome on a call already written (a bridged call). False when no such call is the prospect's. */
export function setCallOutcome(
  db: Database,
  input: {
    id: number;
    prospectId: number;
    outcome: CallOutcome;
    note?: string | null;
    durationSec?: number | null;
    playName?: string | null;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE calls SET outcome = ?, reply_intent = ?, note = COALESCE(?, note),
                duration_sec = COALESCE(?, duration_sec), play_name = COALESCE(play_name, ?)
         WHERE id = ? AND prospect_id = ?`,
      )
      .run(
        input.outcome,
        callReplyIntent(input.outcome),
        input.note ?? null,
        input.durationSec ?? null,
        input.playName ?? null,
        input.id,
        input.prospectId,
      ).changes > 0
  );
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
  db.prepare("UPDATE prospects SET phone = NULL WHERE id = ?").run(prospectId);
  return true;
}

/** The number a call dialled, as stored on it; null when none. */
export function callPhone(db: Database, callId: number): string | null {
  const row = db.query("SELECT phone FROM calls WHERE id = ?").get(callId) as {
    phone: string | null;
  } | null;
  return row?.phone ?? null;
}

/**
 * Every number stored for a prospect, as written: their own `phone`, then the
 * newest queue row's `payload.phone` (where a phone lookup writes it), matched
 * by prospect, else by the prospect's email. Also the newest queue row, for
 * the Find phone button. `phoneForCall` (plays) normalises these.
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
          "q.prospect_id IS NULL AND json_valid(q.payload_json) AND lower(json_extract(q.payload_json, '$.email')) = lower(?)",
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

/** Numbers a call was logged `wrong_number` on, per prospect, normalised as `pickCallPhone` compares them. */
export function wrongNumbersFor(
  db: Database,
  prospectIds: readonly number[],
  defaultCountry = "US",
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (let i = 0; i < prospectIds.length; i += 400) {
    const ids = prospectIds.slice(i, i + 400);
    if (ids.length === 0) continue;
    const rows = db
      .query(
        `SELECT prospect_id, phone FROM calls
          WHERE prospect_id IN (${ids.map(() => "?").join(",")})
            AND outcome = 'wrong_number' AND phone IS NOT NULL`,
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

/** The brief cached for a prospect outside a cadence, or null. */
export function getCallBrief(
  db: Database,
  prospectId: number,
): { brief: CallBrief; playName: string | null; briefAt: string } | null {
  const row = db
    .query("SELECT brief_json, play_name, brief_at FROM call_briefs WHERE prospect_id = ?")
    .get(prospectId) as { brief_json: string; play_name: string | null; brief_at: string } | null;
  const brief = row ? parseJson<CallBrief>(row.brief_json) : null;
  return row && brief ? { brief, playName: row.play_name, briefAt: row.brief_at } : null;
}

export function saveCallBrief(
  db: Database,
  input: { prospectId: number; playName: string | null; brief: CallBrief },
): void {
  db.prepare(
    `INSERT INTO call_briefs (prospect_id, play_name, brief_json, brief_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(prospect_id) DO UPDATE SET play_name = excluded.play_name,
       brief_json = excluded.brief_json, brief_at = excluded.brief_at`,
  ).run(input.prospectId, input.playName, JSON.stringify(input.brief), new Date().toISOString());
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

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/**
 * Everyone with a number the Calls page may list, best first, capped at
 * `limit`. Gates in SQL: contact still allowed on every channel
 * (`contactAllowedSetClause`, which includes a call logged do-not-contact), not
 * rejected off-ICP, no meeting held, no cadence stopped as do-not-contact.
 * A bounced email does not block a call: the number is a different address.
 * The company do-not-contact list is the caller's (it is config).
 *
 * Order: a positive reply (email intent, or a call logged interested) with no
 * meeting booked or held yet; then connected on LinkedIn (an accepted invite
 * or a known connection); then in a live cadence, by its queue row's priority
 * score; then the rest, most recently touched first.
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
  const meetingHeld = hasTable(db, "meetings")
    ? `EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id AND m.outcome = 'held')`
    : "0";
  const meetingAny = hasTable(db, "meetings")
    ? `EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id AND COALESCE(m.outcome, '') NOT IN ('cancelled', 'no_show'))`
    : "0";
  const intents = POSITIVE_INTENTS.map((l) => `'${l.replace(/'/g, "''")}'`).join(",");
  const positiveIntent = `COALESCE(
      (SELECT ir.intent FROM inbox_replies ir
        WHERE ir.prospect_id = p.id AND ir.intent IN (${intents})
        ORDER BY ir.received_at DESC LIMIT 1),
      (SELECT 'interested' FROM calls cl WHERE cl.prospect_id = p.id AND cl.outcome = 'interested' LIMIT 1))`;
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
       -- A phone on a queue row not linked to any prospect yet, by its
       -- address, as phoneSourcesFor reads it: target_queue's JSON is read
       -- once here, never once per prospect.
       mail_queue AS MATERIALIZED (
         SELECT lower(trim(json_extract(q.payload_json, '$.email'))) AS email, MAX(q.id) AS id
           FROM target_queue q
          WHERE q.prospect_id IS NULL AND json_valid(q.payload_json)
            AND trim(COALESCE(json_extract(q.payload_json, '$.phone'), '')) <> ''
            AND trim(COALESCE(json_extract(q.payload_json, '$.email'), '')) <> ''
          GROUP BY 1),
       mail_phone AS MATERIALIZED (
         SELECT m.email, m.id, trim(json_extract(q.payload_json, '$.phone')) AS phone
           FROM mail_queue m JOIN target_queue q ON q.id = m.id),
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
                 OR lower(trim(p.email)) IN (SELECT email FROM mail_phone))
            AND ${contactAllowedSetClause(db)}
            AND COALESCE(p.icp_verdict, '') <> 'reject'
            AND NOT (${meetingHeld})
            AND NOT EXISTS (SELECT 1 FROM cadence_state dnc WHERE dnc.prospect_id = p.id
                             AND dnc.status = 'stopped' AND dnc.stop_reason = 'do_not_contact')
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
 * the same as `listCallCandidates`': contact allowed, not off-ICP, no meeting
 * held. False when any refuses.
 */
export function callAllowed(db: Database, prospectId: number): boolean {
  const meetingHeld = hasTable(db, "meetings")
    ? `EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id AND m.outcome = 'held')`
    : "0";
  return (
    db
      .query(
        `SELECT 1 FROM prospects p
          WHERE p.id = ? AND ${contactAllowedClause(db)}
            AND COALESCE(p.icp_verdict, '') <> 'reject'
            AND NOT (${meetingHeld})`,
      )
      .get(prospectId) != null
  );
}

/** `callAllowed` for many prospects at once (the Calls page's due rows): the ones allowed. */
export function callAllowedIds(db: Database, prospectIds: readonly number[]): Set<number> {
  const out = new Set<number>();
  const meetingHeld = hasTable(db, "meetings")
    ? `EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id AND m.outcome = 'held')`
    : "0";
  const allowed = contactAllowedSetClause(db);
  for (let i = 0; i < prospectIds.length; i += 400) {
    const ids = prospectIds.slice(i, i + 400);
    if (ids.length === 0) continue;
    const rows = db
      .query(
        `SELECT p.id FROM prospects p
          WHERE p.id IN (${ids.map(() => "?").join(",")}) AND ${allowed}
            AND COALESCE(p.icp_verdict, '') <> 'reject'
            AND NOT (${meetingHeld})`,
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
