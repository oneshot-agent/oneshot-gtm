import type { Database } from "bun:sqlite";
import type {
  MeetingMatchMethod,
  MeetingMatchStatus,
  MeetingOutcome,
  MeetingRecord,
} from "./types.ts";

/**
 * Calendar meeting persistence over a raw Database handle: upsert/read of
 * the `meetings` table, outcome recording, and founder review/dismiss
 * actions on prospect-match suggestions. Extracted from `Ledger` (issue
 * #751); `Ledger` delegates every meeting method here unchanged.
 */

/**
 * Upsert one calendar event. NEVER `INSERT OR REPLACE` (a cancellation
 * stub carries almost no fields and would wipe summary/prospect_id/
 * outcome) and NEVER `INSERT OR IGNORE` (unlike an immutable inbox_replies
 * row, an event mutates in place. A reschedule or cancellation is an
 * UPDATE to the same row). `undefined` on any field means "this poll
 * response didn't carry it" and preserves the existing value via
 * `COALESCE(excluded.col, meetings.col)`; pass `null` explicitly to CLEAR
 * a field.
 *
 * Two special cases the caller relies on:
 *  - A cancellation stub (`status: 'cancelled'`, no `startsAt`) for an
 *    event this ledger has never seen is a no-op: there's no start time
 *    to even file a ghost row under, so nothing is inserted.
 *  - A reschedule (an existing row whose `startsAt` differs from the new
 *    value) clears `outcomePromptedAt`. A stale nudge must withdraw:
 *    while leaving any already-recorded `outcome` untouched.
 *
 * Returns whether this event is new to the ledger and whether its
 * `attendeesFingerprint` changed since last seen. The poller uses the
 * latter to decide whether re-matching is worth running at all (a
 * founder's dismiss must stick until the attendee set actually changes).
 */
export function upsertMeeting(
  db: Database,
  input: {
    calendarId: string;
    eventId: string;
    icalUid?: string | null;
    recurringEventId?: string | null;
    status: string;
    summary?: string | null;
    allDay?: boolean;
    startsAt?: string | null;
    endsAt?: string | null;
    eventTimezone?: string | null;
    organizerEmail?: string | null;
    selfResponse?: string | null;
    externalAttendeeCount?: number;
    externalAttendeesJson?: string | null;
    attendeesOmitted?: boolean;
    matchStatus?: MeetingMatchStatus;
    matchMethod?: MeetingMatchMethod;
    matchConfidence?: number | null;
    prospectId?: number | null;
    suggestedProspectId?: number | null;
    eventUpdatedAt?: string | null;
    attendeesFingerprint?: string | null;
  },
): { isNew: boolean; fingerprintChanged: boolean } {
  const existing = db
    .query(
      `SELECT starts_at, attendees_fingerprint FROM meetings
       WHERE calendar_id = ? AND event_id = ?`,
    )
    .get(input.calendarId, input.eventId) as
    | { starts_at: string | null; attendees_fingerprint: string | null }
    | undefined;
  const isNew = !existing;
  const fingerprintChanged =
    !existing || (existing.attendees_fingerprint ?? null) !== (input.attendeesFingerprint ?? null);

  const isUnseenCancellationStub = isNew && input.status === "cancelled" && input.startsAt == null;
  if (isUnseenCancellationStub) {
    // Nothing to file this under: deliberately never inserted.
    return { isNew: true, fingerprintChanged: false };
  }

  db.prepare(
    `INSERT INTO meetings (
       calendar_id, event_id, ical_uid, recurring_event_id, status, summary,
       all_day, starts_at, ends_at, event_timezone, organizer_email,
       self_response, external_attendee_count, external_attendees_json,
       attendees_omitted, prospect_id, suggested_prospect_id, match_status,
       match_method, match_confidence, event_updated_at, attendees_fingerprint,
       first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               datetime('now'), datetime('now'))
     ON CONFLICT(calendar_id, event_id) DO UPDATE SET
       ical_uid                = COALESCE(excluded.ical_uid, meetings.ical_uid),
       recurring_event_id      = COALESCE(excluded.recurring_event_id, meetings.recurring_event_id),
       status                  = COALESCE(excluded.status, meetings.status),
       summary                 = COALESCE(excluded.summary, meetings.summary),
       all_day                 = COALESCE(excluded.all_day, meetings.all_day),
       -- A reschedule (starts_at genuinely changes) withdraws any stale
       -- nudge; the recorded outcome itself is untouched either way.
       outcome_prompted_at     = CASE
         WHEN excluded.starts_at IS NOT NULL AND excluded.starts_at IS NOT meetings.starts_at
           THEN NULL ELSE meetings.outcome_prompted_at END,
       starts_at               = COALESCE(excluded.starts_at, meetings.starts_at),
       ends_at                 = COALESCE(excluded.ends_at, meetings.ends_at),
       event_timezone          = COALESCE(excluded.event_timezone, meetings.event_timezone),
       organizer_email         = COALESCE(excluded.organizer_email, meetings.organizer_email),
       self_response           = COALESCE(excluded.self_response, meetings.self_response),
       external_attendee_count = COALESCE(excluded.external_attendee_count, meetings.external_attendee_count),
       external_attendees_json = COALESCE(excluded.external_attendees_json, meetings.external_attendees_json),
       attendees_omitted       = COALESCE(excluded.attendees_omitted, meetings.attendees_omitted),
       -- A founder dismissal ('dismissed') must survive a re-poll that
       -- carries no new match verdict (matchStatus undefined) — but a
       -- fresh verdict from the matcher (always passed together with a
       -- changed fingerprint) overwrites it, which is how a dismiss is
       -- allowed to lapse once the attendee set actually changes.
       prospect_id             = COALESCE(excluded.prospect_id, meetings.prospect_id),
       suggested_prospect_id   = excluded.suggested_prospect_id,
       match_status            = COALESCE(excluded.match_status, meetings.match_status),
       match_method            = excluded.match_method,
       match_confidence        = excluded.match_confidence,
       event_updated_at        = COALESCE(excluded.event_updated_at, meetings.event_updated_at),
       attendees_fingerprint   = COALESCE(excluded.attendees_fingerprint, meetings.attendees_fingerprint),
       last_seen_at            = datetime('now')`,
  ).run(
    input.calendarId,
    input.eventId,
    input.icalUid ?? null,
    input.recurringEventId ?? null,
    input.status,
    input.summary ?? null,
    // NOT NULL columns (schema DEFAULT 0): must never bind NULL, or a
    // fresh INSERT (no existing row for the ON CONFLICT COALESCE to
    // fall back to) violates the constraint. The real caller
    // (packages/plays' calendar poller) always supplies these three
    // explicitly on every call, so defaulting an omitted one to
    // false/0 here never actually fires in production.
    input.allDay ? 1 : 0,
    input.startsAt ?? null,
    input.endsAt ?? null,
    input.eventTimezone ?? null,
    input.organizerEmail ?? null,
    input.selfResponse ?? null,
    input.externalAttendeeCount ?? 0,
    input.externalAttendeesJson ?? null,
    input.attendeesOmitted ? 1 : 0,
    input.prospectId ?? null,
    input.suggestedProspectId ?? null,
    input.matchStatus ?? null,
    input.matchMethod ?? null,
    input.matchConfidence ?? null,
    input.eventUpdatedAt ?? null,
    input.attendeesFingerprint ?? null,
  );
  return { isNew, fingerprintChanged };
}

export function getMeeting(
  db: Database,
  calendarId: string,
  eventId: string,
): MeetingRecord | null {
  return (
    (db
      .query(`SELECT * FROM meetings WHERE calendar_id = ? AND event_id = ?`)
      .get(calendarId, eventId) as MeetingRecord) ?? null
  );
}

/**
 * The fast path for an unchanged event (`event_updated_at` hasn't
 * advanced since last poll): touch `last_seen_at` only, skip re-deriving
 * anything else. Returns false (no-op) if the row doesn't exist.
 */
export function touchMeetingLastSeen(db: Database, calendarId: string, eventId: string): boolean {
  const res = db
    .prepare(
      `UPDATE meetings SET last_seen_at = datetime('now') WHERE calendar_id = ? AND event_id = ?`,
    )
    .run(calendarId, eventId);
  return res.changes > 0;
}

/**
 * Past meetings linked to a prospect with no recorded outcome yet. The
 * /inbox-style "awaiting" list. Grace period so a call that ran long
 * isn't nagged about the instant it crosses `ends_at`. Declined-by-founder
 * and all-day rows are excluded: a self-block or an all-day conference is
 * not a call, and COALESCE(self_response,'accepted') reads a NULL
 * response (never triaged, or an old row) as accepted rather than
 * silently dropping it from the nudge.
 */
export function listPendingOutcomeMeetings(db: Database): MeetingRecord[] {
  return db
    .query(
      `SELECT * FROM meetings
       WHERE outcome IS NULL AND status = 'confirmed' AND all_day = 0
         AND prospect_id IS NOT NULL
         AND COALESCE(self_response, 'accepted') <> 'declined'
         -- ends_at is Google's RFC 3339 with the event's own offset
         -- (or ISO Z for all-day events); julianday reads both as UTC. A
         -- string compare against datetime('now') held back every meeting
         -- ending on today's UTC date.
         AND julianday(ends_at) < julianday('now', '-30 minutes')
       ORDER BY julianday(ends_at) DESC`,
    )
    .all() as MeetingRecord[];
}

/** Founder-facing review queue: events with a fuzzy suggestion or an ambiguous multi-candidate match, unresolved. */
export function listMeetingsForReview(db: Database): MeetingRecord[] {
  return db
    .query(
      `SELECT * FROM meetings
       WHERE match_status IN ('suggested', 'ambiguous')
       ORDER BY julianday(starts_at) DESC`,
    )
    .all() as MeetingRecord[];
}

/** Record a founder-set outcome. Clears outcome_prompted_at is NOT done here. The row is resolved, not withdrawn. */
export function setMeetingOutcome(
  db: Database,
  input: { calendarId: string; eventId: string; outcome: MeetingOutcome; note?: string | null },
): void {
  db.prepare(
    `UPDATE meetings
     SET outcome = ?, outcome_note = ?, outcome_recorded_at = datetime('now')
     WHERE calendar_id = ? AND event_id = ?`,
  ).run(input.outcome, input.note ?? null, input.calendarId, input.eventId);
}

/**
 * The most recent founder-recorded outcome for a prospect's calendar
 * meeting(s) (issue #578): modelled on `contactSuppressionFor`, a ledger
 * read returning a verdict for the reply drafter and cadence gate to act
 * on. This is the DIRECT path from an outcome into a draft: the existing
 * `tagOutcomeValue` → `triggerAngleRefresh` → `prospects.angle_json` path
 * never hands the outcome to the synthesizer as text, so this is a second
 * read, not a replacement. Newest by `outcome_recorded_at` wins when a
 * prospect has more than one resolved meeting.
 */
export function latestMeetingOutcomeFor(
  db: Database,
  prospectId: number,
): { outcome: MeetingOutcome; note: string | null; summary: string | null } | null {
  return (
    (db
      .query(
        `SELECT outcome, outcome_note AS note, summary
         FROM meetings
         WHERE prospect_id = ? AND outcome IS NOT NULL
         ORDER BY outcome_recorded_at DESC, julianday(starts_at) DESC
         LIMIT 1`,
      )
      .get(prospectId) as
      | { outcome: MeetingOutcome; note: string | null; summary: string | null }
      | undefined) ?? null
  );
}

/**
 * Stamp `outcome_prompted_at`: called when the founder is shown the
 * nudge for this meeting, so a UI that dedupes reminders doesn't have to
 * infer "already asked" from anything else. `upsertMeeting`'s reschedule
 * branch clears this back to NULL when `starts_at` genuinely changes, so
 * a stale nudge withdraws on its own.
 */
export function markMeetingPrompted(db: Database, calendarId: string, eventId: string): void {
  db.prepare(
    `UPDATE meetings SET outcome_prompted_at = datetime('now') WHERE calendar_id = ? AND event_id = ?`,
  ).run(calendarId, eventId);
}

/**
 * Founder confirms a suggested/ambiguous match: promotes it to prospect_id
 * and marks match_status 'exact' so it stops appearing in the review queue
 * (it's still surfaced via prospect_id everywhere else).
 */
export function confirmMeetingMatch(
  db: Database,
  calendarId: string,
  eventId: string,
  prospectId: number,
): void {
  db.prepare(
    `UPDATE meetings
     SET prospect_id = ?, match_status = 'exact', suggested_prospect_id = NULL
     WHERE calendar_id = ? AND event_id = ?`,
  ).run(prospectId, calendarId, eventId);
}

/**
 * Founder dismisses a suggestion. Match_status flips to 'dismissed', which
 * the matcher (packages/plays' calendar poll) must treat as "do not
 * re-suggest" UNTIL `attendees_fingerprint` changes. That's the whole
 * point of storing the fingerprint.
 */
export function dismissMeetingMatch(db: Database, calendarId: string, eventId: string): void {
  db.prepare(
    `UPDATE meetings
     SET match_status = 'dismissed', suggested_prospect_id = NULL
     WHERE calendar_id = ? AND event_id = ?`,
  ).run(calendarId, eventId);
}
