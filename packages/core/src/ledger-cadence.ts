import type { Database } from "bun:sqlite";
import type { CadencePlanStep, ChannelEventRecord, SequenceEventRecord } from "./types.ts";

/**
 * Cadence persistence extracted from `Ledger` (#633) — the next slice of the
 * ledger split tracked in ROADMAP.md, following the receipt (#616), cache
 * (#618) and delivery-health (#617) extractions. Covers cadence creation,
 * lookup, step advancement, skip records, stop/disposition handling,
 * due-step queries, and the cadence-specific transactions that credit a
 * reply to a play and stop live cadences (email + LinkedIn), plus the
 * `cadence_plans` (direct-mail schedule) table.
 *
 * Pure functions of a raw `Database` handle, mirroring `delivery-health.ts`'s
 * pattern: no dependency on the `Ledger` class, so this domain can be read
 * and tested in isolation. `Ledger`'s own cadence methods (ledger.ts) are now
 * thin delegates to the functions below — same names, same signatures, same
 * SQL, same transaction boundaries — so every call site and the exported
 * `Ledger` surface are unchanged.
 */

/** A `cadence_state` row joined with the prospect details needed by cadence surfaces. */
export interface CadenceWithProspect {
  prospect_id: number;
  play_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_due_at: string | null;
  last_polled_at: string | null;
  stop_reason: string | null;
  stop_note: string | null;
  stopped_at: string | null;
  next_step_draft_json: string | null;
  next_step_drafted_at: string | null;
  /**
   * ISO timestamp when a fire-and-forget send was claimed for this cadence.
   * Null = no send in flight. Survives server restart so the UI's "sending"
   * spinner doesn't get stranded by a `bun --watch` reload mid-SDK-call.
   */
  sending_started_at: string | null;
  /** Last send-failure message (truncated); cleared on any forward progress.
   *  Non-null = the most recent send attempt failed and nothing has succeeded
   *  since — drives the "send failed · retrying" row indicator. */
  last_send_error: string | null;
  /** ISO timestamp of `last_send_error`. */
  last_send_error_at: string | null;
  prospect_email: string | null;
  prospect_name: string | null;
  prospect_company: string | null;
  prospect_title: string | null;
  prospect_linkedin_url: string | null;
  reply_channel: "email" | "linkedin" | null;
  replied_at: string | null;
}

/**
 * Subject as a thread key: reply/forward prefixes stripped (en/de/fr/es/sv/
 * pt/nl variants, repeated), case-folded, whitespace collapsed. Empty → null.
 */
function normalizeSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  let s = subject.trim();
  // Each `\s*` is reachable by exactly one path, so a run of spaces can't be
  // split between two of them (CodeQL: polynomial backtracking).
  const prefix = /^(?:re|fw|fwd|aw|wg|sv|vs|rv|enc|tr|antw)(?:\s*\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.length > 0 ? s : null;
}

export function enrollCadence(
  db: Database,
  input: { prospectId: number; playName: string; nextDueAt: string },
): void {
  db.prepare(
    `INSERT INTO cadence_state(prospect_id, play_name, current_step, status, next_due_at)
     VALUES(?, ?, 0, 'active', ?)
     ON CONFLICT(prospect_id, play_name) DO UPDATE SET
       status = 'active',
       next_due_at = excluded.next_due_at,
       last_polled_at = NULL,
       stop_reason = NULL,
       stop_note = NULL,
       stopped_at = NULL,
       last_send_error = NULL,
       last_send_error_at = NULL
     WHERE cadence_state.status != 'stopped'`,
  ).run(input.prospectId, input.playName, input.nextDueAt);
}

export function listActiveCadences(
  db: Database,
  opts: { dueByIso?: string } = {},
): CadenceWithProspect[] {
  const where: string[] = ["c.status = 'active'"];
  const args: unknown[] = [];
  if (opts.dueByIso) {
    where.push("(c.next_due_at IS NULL OR c.next_due_at <= ?)");
    args.push(opts.dueByIso);
  }
  const sql = `
    SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
           p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
           (SELECT channel FROM (
              SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL
              SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS reply_channel,
           (SELECT at FROM (
              SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL
              SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS replied_at
    FROM cadence_state c
    JOIN prospects p ON p.id = c.prospect_id
    WHERE ${where.join(" AND ")}
    ORDER BY c.next_due_at ASC NULLS LAST
  `;
  return db.query(sql).all(...(args as never[])) as never;
}

export function listAllCadences(db: Database): CadenceWithProspect[] {
  const sql = `
    SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
           p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
           (SELECT channel FROM (
              SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS reply_channel,
           (SELECT at FROM (
              SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS replied_at
    FROM cadence_state c
    JOIN prospects p ON p.id = c.prospect_id
    ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
  `;
  return db.query(sql).all() as never;
}

/**
 * Single cadence (joined with its prospect) by (prospect_id, play_name) — an
 * index seek on the `cadence_state` PRIMARY KEY. Replaces the O(n)
 * `listAllCadences().find(...)` scan callers used to do per row.
 */
export function getCadence(
  db: Database,
  prospectId: number,
  playName: string,
): CadenceWithProspect | null {
  const sql = `
    SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
           p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
           (SELECT channel FROM (
              SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS reply_channel,
           (SELECT at FROM (
              SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS replied_at
    FROM cadence_state c
    JOIN prospects p ON p.id = c.prospect_id
    WHERE c.prospect_id = ? AND c.play_name = ?
  `;
  return (db.query(sql).get(prospectId, playName) as CadenceWithProspect) ?? null;
}

/** All cadences for one prospect — index seek on cadence_state.prospect_id (PK prefix). */
export function listCadencesForProspect(db: Database, prospectId: number): CadenceWithProspect[] {
  const sql = `
    SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
           p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
           (SELECT channel FROM (
              SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS reply_channel,
           (SELECT at FROM (
              SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
              UNION ALL SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
            ) ORDER BY at DESC LIMIT 1) AS replied_at
    FROM cadence_state c
    JOIN prospects p ON p.id = c.prospect_id
    WHERE c.prospect_id = ?
    ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
  `;
  return db.query(sql).all(prospectId) as never;
}

export function advanceCadence(
  db: Database,
  input: {
    prospectId: number;
    playName: string;
    newStep: number;
    nextDueAt: string | null;
  },
): void {
  // Also clear any persisted next-step draft AND the sending marker — the
  // draft was for the OLD next step (stale after advance), and a successful
  // advance means the in-flight send for this row is done. /cadences will
  // surface a fresh "no preview yet" state.
  // A successful advance also clears any prior send-failure marker (the send
  // that just advanced us obviously succeeded).
  db.prepare(
    `UPDATE cadence_state
     SET current_step = ?, next_due_at = ?, last_polled_at = datetime('now'),
         next_step_draft_json = NULL, next_step_drafted_at = NULL,
         sending_started_at = NULL,
         last_send_error = NULL, last_send_error_at = NULL
     WHERE prospect_id = ? AND play_name = ?`,
  ).run(input.newStep, input.nextDueAt, input.prospectId, input.playName);
}

/**
 * Record the last cadence send FAILURE so /cadences can show the row is
 * blocked upstream (vs. waiting on the founder). Cleared by advanceCadence /
 * setCadenceStatus on any forward progress. No-op if the row is gone.
 */
export function recordCadenceSendError(
  db: Database,
  input: { prospectId: number; playName: string; error: string },
): void {
  db.prepare(
    `UPDATE cadence_state
     SET last_send_error = ?, last_send_error_at = datetime('now')
     WHERE prospect_id = ? AND play_name = ?`,
  ).run(input.error.slice(0, 200), input.prospectId, input.playName);
}

export function setCadenceStatus(
  db: Database,
  input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed" | "bounced" | "off-icp" | "unsubscribed";
  },
): void {
  // Non-active terminal states clear the persisted draft AND any send
  // marker — a replied / breakup / completed / bounced cadence shouldn't have
  // a sendable preview hanging around or a stuck "sending" flag. A reply /
  // breakup / completion / bounce also clears any stale send-failure marker
  // (for a bounce that marker is actively misleading: it reads as
  // "retrying", but a dead address will never accept a retry).
  db.prepare(
    `UPDATE cadence_state
     SET status = ?,
         next_step_draft_json = CASE WHEN ? = 'active' THEN next_step_draft_json ELSE NULL END,
         next_step_drafted_at = CASE WHEN ? = 'active' THEN next_step_drafted_at ELSE NULL END,
         sending_started_at = CASE WHEN ? = 'active' THEN sending_started_at ELSE NULL END,
         last_send_error = CASE WHEN ? = 'active' THEN last_send_error ELSE NULL END,
         last_send_error_at = CASE WHEN ? = 'active' THEN last_send_error_at ELSE NULL END
     WHERE prospect_id = ? AND play_name = ?`,
  ).run(
    input.status,
    input.status,
    input.status,
    input.status,
    input.status,
    input.status,
    input.prospectId,
    input.playName,
  );
}

/**
 * Expire any queued/approved `breakup-revive` row for this prospect — a stop
 * or a reply means the deliberate re-engagement play should no longer fire.
 * Shared by `stopCadence`, `recordLinkedInReply` and `recordProspectReply`.
 */
function expireBreakupReviveQueue(db: Database, prospectId: number, reason: string): void {
  db.prepare(
    `UPDATE target_queue
     SET status = 'expired',
         notes = CASE WHEN notes IS NULL OR notes = '' THEN ?
                      ELSE notes || ' · ' || ? END
     WHERE (prospect_id = ? OR dedupe_key = ?)
       AND play_name = 'breakup-revive'
       AND status IN ('pending', 'approved')`,
  ).run(`expired: ${reason}`, `expired: ${reason}`, prospectId, `prospect:${prospectId}`);
}

export function stopCadence(
  db: Database,
  input: {
    prospectId: number;
    playName: string;
    reason: "bad_timing" | "other" | "not_a_fit" | "do_not_contact";
    note?: string;
  },
): boolean {
  let changed = false;
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE cadence_state
         SET status = 'stopped', stop_reason = ?, stop_note = ?, stopped_at = datetime('now'),
             next_due_at = NULL,
             next_step_draft_json = NULL, next_step_drafted_at = NULL,
             sending_started_at = NULL, last_send_error = NULL, last_send_error_at = NULL
         WHERE prospect_id = ? AND play_name = ? AND status = 'active'
           AND sending_started_at IS NULL`,
      )
      .run(input.reason, input.note?.trim() || null, input.prospectId, input.playName);
    changed = result.changes > 0;
    if (changed) {
      expireBreakupReviveQueue(db, input.prospectId, "cadence stopped");
    }
  })();
  return changed;
}

export function setCadenceDraft(
  db: Database,
  input: {
    prospectId: number;
    playName: string;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      payload: unknown;
    };
  },
): void {
  const draftedAtIso = new Date().toISOString();
  const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
  db.prepare(
    `UPDATE cadence_state
     SET next_step_draft_json = ?, next_step_drafted_at = ?
     WHERE prospect_id = ? AND play_name = ?`,
  ).run(json, draftedAtIso, input.prospectId, input.playName);
}

export function getCadenceDraft(
  db: Database,
  input: { prospectId: number; playName: string },
): {
  subject: string;
  body: string;
  flags: string[];
  payload: unknown;
  draftedAt: string;
} | null {
  const row = db
    .query(
      `SELECT next_step_draft_json AS j FROM cadence_state
       WHERE prospect_id = ? AND play_name = ?`,
    )
    .get(input.prospectId, input.playName) as { j: string | null } | null;
  if (!row?.j) return null;
  try {
    return JSON.parse(row.j) as {
      subject: string;
      body: string;
      flags: string[];
      payload: unknown;
      draftedAt: string;
    };
  } catch {
    return null;
  }
}

export function clearCadenceDraft(
  db: Database,
  input: { prospectId: number; playName: string },
): void {
  db.prepare(
    `UPDATE cadence_state
     SET next_step_draft_json = NULL, next_step_drafted_at = NULL
     WHERE prospect_id = ? AND play_name = ?`,
  ).run(input.prospectId, input.playName);
}

/**
 * Sweep stale `sending_started_at` markers (any non-null value when
 * `staleAgeMs` is 0 — cold-boot semantics). A matching sequence_event means
 * the send went out: clear the marker only; no event means it was stranded:
 * clear the marker but keep the draft. Returns swept rows; takes `now` +
 * `maxAgeMs` as args so tests don't fake the clock.
 */
export function sweepStaleCadenceSends(
  db: Database,
  input: { now: Date; maxAgeMs: number },
): Array<{
  prospectId: number;
  playName: string;
  startedAt: string;
  ageMs: number;
  actuallySent: boolean;
}> {
  const cutoffMs = input.now.getTime() - input.maxAgeMs;
  const rows = db
    .query(
      `SELECT prospect_id, play_name, current_step, sending_started_at
       FROM cadence_state
       WHERE sending_started_at IS NOT NULL`,
    )
    .all() as Array<{
    prospect_id: number;
    play_name: string;
    current_step: number;
    sending_started_at: string;
  }>;
  const swept: Array<{
    prospectId: number;
    playName: string;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> = [];
  const checkEvent = db.prepare(
    `SELECT 1 FROM sequence_events
     WHERE prospect_id = ? AND play_name = ? AND step_index = ?
       AND status IN ('sent','delivered','replied')
     LIMIT 1`,
  );
  const clear = db.prepare(
    `UPDATE cadence_state
     SET sending_started_at = NULL
     WHERE prospect_id = ? AND play_name = ?`,
  );
  for (const row of rows) {
    const startedMs = new Date(row.sending_started_at).getTime();
    if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue; // still fresh
    const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
    // The in-flight step's step_index is `current_step + 1` (= nextIndex in the
    // engine): the marker is claimed while current_step still holds the OLD
    // value, and `recordSequenceEvent` writes at nextIndex. So "did the
    // in-flight send land?" checks current_step + 1. We also check current_step
    // to cover the race where advanceCadence already ran (current_step moved to
    // the sent step) but the marker hadn't been cleared yet.
    const sentInflight = checkEvent.get(row.prospect_id, row.play_name, row.current_step + 1);
    const sentAfterAdvance = checkEvent.get(row.prospect_id, row.play_name, row.current_step);
    const actuallySent = sentInflight != null || sentAfterAdvance != null;
    clear.run(row.prospect_id, row.play_name);
    swept.push({
      prospectId: row.prospect_id,
      playName: row.play_name,
      startedAt: row.sending_started_at,
      ageMs,
      actuallySent,
    });
  }
  return swept;
}

export function recordLinkedInReply(
  db: Database,
  input: {
    prospectId: number;
    source: string;
    externalEventId: string;
    occurredAt: string;
    /** The message text, when the channel supplies one. Feeds the composer. */
    body?: string | null;
  },
): {
  duplicate: boolean;
  prospectId: number;
  cadencesStopped: number;
  inFlightSends: number;
} {
  return db.transaction(() => {
    const existing = db
      .query(`SELECT * FROM channel_events WHERE source = ? AND external_event_id = ?`)
      .get(input.source, input.externalEventId) as ChannelEventRecord | null;
    if (existing) {
      const inFlight = db
        .query(
          `SELECT COUNT(*) AS n FROM cadence_state
           WHERE prospect_id = ? AND sending_started_at IS NOT NULL`,
        )
        .get(existing.prospect_id) as { n: number };
      return {
        duplicate: true,
        prospectId: existing.prospect_id,
        cadencesStopped: 0,
        inFlightSends: inFlight.n,
      };
    }
    const live = db
      .query(
        `SELECT sending_started_at FROM cadence_state
         WHERE prospect_id = ? AND status IN ('active','paused')`,
      )
      .all(input.prospectId) as Array<{ sending_started_at: string | null }>;
    db.prepare(
      `INSERT INTO channel_events
         (source, external_event_id, prospect_id, channel, event_type, occurred_at, body)
       VALUES (?, ?, ?, 'linkedin', 'reply', ?, ?)`,
    ).run(
      input.source,
      input.externalEventId,
      input.prospectId,
      input.occurredAt,
      input.body?.trim() || null,
    );
    db.prepare(
      `UPDATE cadence_state
       SET status = 'replied', next_due_at = NULL,
           next_step_draft_json = NULL, next_step_drafted_at = NULL,
           last_send_error = NULL, last_send_error_at = NULL
       WHERE prospect_id = ? AND status IN ('active','paused')`,
    ).run(input.prospectId);
    expireBreakupReviveQueue(db, input.prospectId, "prospect replied");
    return {
      duplicate: false,
      prospectId: input.prospectId,
      cadencesStopped: live.length,
      inFlightSends: live.filter((row) => row.sending_started_at != null).length,
    };
  })();
}

/** Stop future work on one live cadence without hiding a send already handed to a provider. */
function markCadenceReplied(db: Database, prospectId: number, playName: string): void {
  db.prepare(
    `UPDATE cadence_state
     SET status = 'replied', next_due_at = NULL,
         next_step_draft_json = NULL, next_step_drafted_at = NULL,
         last_send_error = NULL, last_send_error_at = NULL
     WHERE prospect_id = ? AND play_name = ? AND status IN ('active','paused')`,
  ).run(prospectId, playName);
}

/**
 * Mark the latest sent step `replied` — a state transition of the existing
 * step, NOT a new event, so `sent` counts stay correct. Idempotent per
 * (prospect, play) via the NOT EXISTS guard; returns true on the one call
 * that flips a row. Stamps `replied_at` to the actual reply moment — the
 * row's `created_at` stays pinned to the original SEND time, so date-windowed
 * rollups (eventsByPlay, the Slack daily summary) must use replied_at, not
 * created_at, to count a reply on the day it happened rather than the day it
 * was sent. `repliedAt` defaults to now (the manual-reply / UI-send path,
 * where the moment of the call IS the reply); the background inbox poll
 * passes the inbound email's own `received_at` so a reply pulled from a
 * backlog page — arriving in this process well after it actually landed in
 * the mailbox — is still credited to the day it was actually sent, not the
 * day this poll happened to run.
 */
export function markLatestStepReplied(
  db: Database,
  input: {
    prospectId: number;
    playName: string;
    repliedAt?: string | null;
  },
): boolean {
  // datetime(?) normalizes any SQLite-recognized input (an ISO 8601 string
  // with 'T'/'Z', or the 'YYYY-MM-DD HH:MM:SS' form) to the latter — the
  // same format datetime('now') already writes everywhere else in this
  // table. Storing repliedAt un-normalized would make replied_at sort
  // lexicographically wrong against created_at / sinceIso / untilIso
  // (ISO's 'T' separator sorts after the space datetime('now') uses).
  const result = db
    .prepare(
      `UPDATE sequence_events SET status = 'replied', replied_at = datetime(COALESCE(?, 'now'))
       WHERE id = (
         SELECT id FROM sequence_events
         WHERE prospect_id = ? AND play_name = ? AND channel = 'email'
           AND status IN ('sent','delivered')
         ORDER BY created_at DESC, id DESC LIMIT 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM sequence_events
         WHERE prospect_id = ? AND play_name = ? AND status = 'replied'
       )`,
    )
    .run(
      input.repliedAt ?? null,
      input.prospectId,
      input.playName,
      input.prospectId,
      input.playName,
    );
  return result.changes > 0;
}

/**
 * Single source of truth for "a prospect replied to a cadence" — writes both
 * planes in one transaction so they can't drift. Control plane
 * (`cadence_state.status='replied'`) is conservative: only a live cadence
 * (`active`/`paused`) flips, so a terminal sequence is never resurrected.
 * Analytics plane (sequence_events) is unconditional: the event is recorded
 * for ANY status — gating the two together silently drops replies that
 * arrive after a sequence finishes. Count replies on `eventRecorded` (true
 * exactly once per (prospect, play)); `newlyReplied` marks the control
 * transition.
 */
export function recordCadenceReply(
  db: Database,
  input: { prospectId: number; playName: string; repliedAt?: string | null },
): {
  newlyReplied: boolean;
  eventRecorded: boolean;
} {
  return db.transaction(() => {
    const cad = getCadence(db, input.prospectId, input.playName);
    const newlyReplied = cad?.status === "active" || cad?.status === "paused";
    if (newlyReplied) {
      markCadenceReplied(db, input.prospectId, input.playName);
    }
    const eventRecorded = markLatestStepReplied(db, {
      prospectId: input.prospectId,
      playName: input.playName,
      repliedAt: input.repliedAt,
    });
    return { newlyReplied, eventRecorded };
  })();
}

/**
 * Which play an EMAIL reply belongs to. With a subject, the sent email whose
 * subject it threads on wins (reply prefixes in a few languages stripped, case
 * and whitespace ignored); otherwise, or when nothing matches, the prospect's
 * most recent sent email. Other channels (sms/voice/linkedin) are never
 * credited with an email reply. Null if never emailed.
 */
export function latestSentPlayForProspect(
  db: Database,
  prospectId: number,
  replySubject?: string | null,
): string | null {
  const wanted = normalizeSubject(replySubject);
  if (wanted) {
    const rows = db
      .query(
        `SELECT play_name, json_extract(metadata_json, '$.subject') AS subject
         FROM sequence_events
         WHERE prospect_id = ? AND channel = 'email'
           AND status IN ('sent','delivered','replied')
           AND json_extract(metadata_json, '$.subject') IS NOT NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(prospectId) as Array<{ play_name: string; subject: string }>;
    const hit = rows.find((r) => normalizeSubject(r.subject) === wanted);
    if (hit) return hit.play_name;
  }
  const row = db
    .query(
      `SELECT play_name FROM sequence_events
       WHERE prospect_id = ? AND channel = 'email'
         AND status IN ('sent','delivered','replied')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(prospectId) as { play_name: string } | null;
  return row?.play_name ?? null;
}

/**
 * Record a reply. Control: EVERY live cadence for the prospect stops —
 * nobody keeps getting follow-ups after answering. Analytics: the reply is
 * credited to exactly ONE play — the one whose sent subject it threads on
 * (`Re: …`), else the most recent play that emailed them. Returns one entry
 * per play touched. `repliedAt` (default now) should be the inbound
 * email's own received/sent timestamp when known — see
 * markLatestStepReplied's note on why the background inbox poll must pass
 * it rather than let this stamp the moment the poll happened to run.
 */
export function recordProspectReply(
  db: Database,
  prospectId: number,
  opts?: { subject?: string | null; repliedAt?: string | null },
): Array<{ playName: string; newlyReplied: boolean; eventRecorded: boolean }> {
  return db.transaction(() => {
    const credited = latestSentPlayForProspect(db, prospectId, opts?.subject);
    const out = new Map<string, { newlyReplied: boolean; eventRecorded: boolean }>();
    for (const cad of listCadencesForProspect(db, prospectId)) {
      const live = cad.status === "active" || cad.status === "paused";
      if (live) {
        markCadenceReplied(db, prospectId, cad.play_name);
      }
      out.set(cad.play_name, { newlyReplied: live, eventRecorded: false });
    }
    if (credited) {
      const eventRecorded = markLatestStepReplied(db, {
        prospectId,
        playName: credited,
        repliedAt: opts?.repliedAt,
      });
      out.set(credited, {
        newlyReplied: out.get(credited)?.newlyReplied ?? false,
        eventRecorded,
      });
    }
    expireBreakupReviveQueue(db, prospectId, "prospect replied");
    return [...out].map(([playName, r]) => ({
      playName,
      newlyReplied: r.newlyReplied,
      eventRecorded: r.eventRecorded,
    }));
  })();
}

export function getCadencePlan(
  db: Database,
  prospectId: number,
  playName: string,
  enrollment: string,
): CadencePlanStep[] | null {
  const row = db
    .query("SELECT steps FROM cadence_plans WHERE prospect_id=? AND play_name=? AND enrollment=?")
    .get(prospectId, playName, enrollment) as { steps: string } | null;
  return row ? JSON.parse(row.steps) : null;
}

export function saveCadencePlan(
  db: Database,
  prospectId: number,
  playName: string,
  enrollment: string,
  steps: CadencePlanStep[],
): void {
  db.query(
    "INSERT INTO cadence_plans VALUES(?,?,?,?) ON CONFLICT(prospect_id,play_name,enrollment) DO UPDATE SET steps=excluded.steps",
  ).run(prospectId, playName, enrollment, JSON.stringify(steps));
}

/**
 * True when a (prospect, play, step) already has a terminal-sent
 * sequence_event. Pre-dispatch guard: a crash between recordSequenceEvent
 * and advanceCadence leaves current_step lagging the sent step — this stops
 * the re-send on the next due tick.
 */
export function hasSentSequenceEvent(
  db: Database,
  prospectId: number,
  playName: string,
  stepIndex: number,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sequence_events
         WHERE prospect_id = ? AND play_name = ? AND step_index = ?
           AND status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(prospectId, playName, stepIndex) != null
  );
}

export function recordSequenceEvent(
  db: Database,
  input: {
    prospectId: number;
    playName: string;
    stepIndex: number;
    channel: SequenceEventRecord["channel"];
    status: SequenceEventRecord["status"];
    metadata?: unknown;
    /** The send receipt this step produced — links the step to its billable call
     *  so an outcome (reply/deal) can tag the receipt's value. */
    receiptId?: number;
    /**
     * The provider's own bounce timestamp (DSN `bouncedAt`), for `status:
     * "bounced"` rows only. `created_at` is stamped at POLL/detection time —
     * this is the real occurrence time, so date-windowed rollups (the Slack
     * daily summary) attribute the bounce to the day it actually happened
     * rather than the day the mailbox happened to be polled.
     */
    bouncedAt?: string;
  },
): number {
  const stmt = db.prepare(`
    INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, metadata_json, receipt_id, bounced_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.prospectId,
    input.playName,
    input.stepIndex,
    input.channel,
    input.status,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.receiptId ?? null,
    input.bouncedAt ?? null,
  );
  return Number(result.lastInsertRowid);
}

/**
 * A play's prior steps for one prospect — every send, plus a letter the
 * founder skipped (#610), so the cadence history says why step N never
 * went out. The conversation view (`listSequenceEventsForProspect`) stays
 * sends-only; so does every counter.
 */
export function listSequenceEventsForProspectPlay(
  db: Database,
  prospectId: number,
  playName: string,
): SequenceEventRecord[] {
  return db
    .query(
      `SELECT * FROM sequence_events
       WHERE prospect_id = ? AND play_name = ?
         AND status IN ('sent','delivered','replied','skipped')
       ORDER BY step_index ASC, id ASC`,
    )
    .all(prospectId, playName) as SequenceEventRecord[];
}

/**
 * Bulk variant of listSequenceEventsForProspectPlay: one round-trip, Map
 * keyed `${prospect_id}|${play_name}`, same (step_index ASC, id ASC)
 * ordering. Index-served by idx_sequence_events_prospect_play.
 */
export function listSequenceEventsForCadences(
  db: Database,
  pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
): Map<string, SequenceEventRecord[]> {
  const map = new Map<string, SequenceEventRecord[]>();
  if (pairs.length === 0) return map;
  const conditions = pairs.map(() => "(prospect_id = ? AND play_name = ?)").join(" OR ");
  const args: unknown[] = [];
  for (const p of pairs) {
    args.push(p.prospectId, p.playName);
  }
  const rows = db
    .query(
      `SELECT * FROM sequence_events
       WHERE (${conditions})
         AND status IN ('sent','delivered','replied','skipped')
       ORDER BY prospect_id ASC, play_name ASC, step_index ASC, id ASC`,
    )
    .all(...(args as never[])) as SequenceEventRecord[];
  for (const r of rows) {
    const key = `${r.prospect_id}|${r.play_name}`;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(r);
  }
  return map;
}

/**
 * Bodies of the most recent email sends for one play + step, newest first.
 * Feeds the opener-frequency lint: a follow-up step that keeps reaching for
 * the same opening words is a fingerprint, and only the ledger knows what
 * the last N sends actually opened with.
 *
 * Same status set as `latestSentEmailCopy` — 'sent' rows are UPDATEd in
 * place to 'replied', so matching only 'sent' would silently drop every
 * prospect who answered and skew the share.
 */
export function recentSentEmailBodies(
  db: Database,
  opts: { playName: string; stepIndex: number; limit?: number },
): string[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const rows = db
    .query(
      `SELECT metadata_json FROM sequence_events
       WHERE play_name = ? AND step_index = ?
         AND status IN ('sent', 'delivered', 'replied')
         AND channel = 'email' AND metadata_json IS NOT NULL
         AND json_valid(metadata_json)
         AND trim(coalesce(json_extract(metadata_json, '$.body'), '')) != ''
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(opts.playName, opts.stepIndex, limit) as Array<{ metadata_json: string }>;
  const out: string[] = [];
  for (const row of rows) {
    let body: unknown;
    try {
      body = (JSON.parse(row.metadata_json) as { body?: unknown }).body;
    } catch {
      continue;
    }
    if (typeof body === "string" && body.trim()) out.push(body);
  }
  return out;
}
