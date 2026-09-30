import type { Database } from "bun:sqlite";
import { contactAllowedClause } from "./contact-optout.ts";
import { toSqliteUtc } from "./time.ts";
import type { InterviewRecord } from "./types.ts";

/**
 * System-level and cross-domain persistence over a raw Database handle that
 * doesn't belong to any single existing domain store: watermark bookkeeping
 * (`poll_state`), signed-webhook replay protection (`webhook_replays`),
 * paid-discovery retry queues (`pending_resolution`, `x_harvested_tweets`),
 * discovery interviews (`interviews`), and the cold-prospect finder that
 * JOINs `prospects`/`sequence_events`/`cadence_state`/`inbox_replies`/
 * `channel_events` (`listColdProspects`). Extracted from `Ledger` (issue
 * #751); `Ledger` delegates every method here unchanged.
 */

export function getPollWatermark(db: Database, key: string): string | null {
  const row = db.query(`SELECT value FROM poll_state WHERE key = ?`).get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

export function setPollWatermark(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO poll_state(key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function recordInterview(
  db: Database,
  input: Omit<InterviewRecord, "id" | "created_at">,
): number {
  const stmt = db.prepare(`
    INSERT INTO interviews(person, transcript_path, jtbd, pain_quotes_json)
    VALUES(?, ?, ?, ?)
  `);
  const result = stmt.run(input.person, input.transcript_path, input.jtbd, input.pain_quotes_json);
  return Number(result.lastInsertRowid);
}

/** Tweet ids the x-reposters finder paid for since `cutoffIso`: skipped on the next harvest. */
export function recentXHarvestedTweetIds(db: Database, cutoffIso: string): Set<string> {
  const rows = db
    .query("SELECT tweet_id FROM x_harvested_tweets WHERE harvested_at >= ?")
    .all(cutoffIso) as Array<{ tweet_id: string }>;
  return new Set(rows.map((r) => r.tweet_id));
}

/**
 * Record tweets just paid for and prune rows past the skip window in one
 * transaction, so the table can't silt. Re-recording an id refreshes its
 * timestamp (a re-buy inside the freshness window restarts its clock).
 */
export function recordXHarvestedTweets(
  db: Database,
  ids: string[],
  nowIso: string,
  pruneCutoffIso: string,
): void {
  const insert = db.prepare(
    `INSERT INTO x_harvested_tweets(tweet_id, harvested_at) VALUES(?, ?)
     ON CONFLICT(tweet_id) DO UPDATE SET harvested_at = excluded.harvested_at`,
  );
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM x_harvested_tweets WHERE harvested_at < ?").run(pruneCutoffIso);
    for (const id of ids) insert.run(id, nowIso);
  });
  tx();
}

/**
 * Persist a candidate whose paid resolution hit a transient platform error,
 * so the retry pass can complete it later (and re-scan won't re-create it).
 * Idempotent: a re-discovered candidate keeps its original first_seen_at and
 * attempt count (the retry pass owns attempt bookkeeping).
 */
export function upsertPendingResolution(
  db: Database,
  input: { playName: string; dedupeKey: string; source: string; raw: unknown },
): void {
  db.prepare(
    `INSERT INTO pending_resolution(play_name, dedupe_key, source, raw_json)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(play_name, dedupe_key) DO UPDATE SET
       source = excluded.source,
       raw_json = excluded.raw_json`,
  ).run(input.playName, input.dedupeKey, input.source, JSON.stringify(input.raw));
}

/** True when (play, dedupeKey) is awaiting retry: finders OR this into their dedup. */
export function isPendingResolution(db: Database, playName: string, dedupeKey: string): boolean {
  const row = db
    .query("SELECT 1 FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
    .get(playName, dedupeKey);
  return row !== null && row !== undefined;
}

/** Pending rows (optionally one play), oldest first, for the retry pass. */
export function listPendingResolution(
  db: Database,
  opts?: { playName?: string; limit?: number },
): Array<{
  play_name: string;
  dedupe_key: string;
  source: string;
  raw_json: string;
  first_seen_at: string;
  last_attempt_at: string | null;
  attempts: number;
}> {
  const where = opts?.playName ? "WHERE play_name = ?" : "";
  const limit = opts?.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
  const sql = `SELECT * FROM pending_resolution ${where} ORDER BY first_seen_at ASC ${limit}`;
  const q = db.query(sql);
  return (opts?.playName ? q.all(opts.playName) : q.all()) as never;
}

/** Mark a pending row as just-attempted (bumps attempts + last_attempt_at). */
export function markPendingResolutionAttempted(
  db: Database,
  playName: string,
  dedupeKey: string,
): void {
  db.prepare(
    `UPDATE pending_resolution
     SET attempts = attempts + 1, last_attempt_at = datetime('now')
     WHERE play_name = ? AND dedupe_key = ?`,
  ).run(playName, dedupeKey);
}

export function deletePendingResolution(db: Database, playName: string, dedupeKey: string): void {
  db.prepare("DELETE FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?").run(
    playName,
    dedupeKey,
  );
}

/**
 * Purge pending rows older than maxAgeMs (permanently-unresolvable or an
 * aged-out time-windowed source) so their dedupe_key frees for future
 * re-discovery and the table doesn't silt. Returns the number removed.
 */
export function sweepStalePendingResolution(db: Database, maxAgeMs: number): number {
  // first_seen_at is SQLite-form (column DEFAULT); an ISO cutoff would
  // purge every row from the cutoff's own day.
  const cutoff = toSqliteUtc(new Date(Date.now() - maxAgeMs));
  const res = db.prepare("DELETE FROM pending_resolution WHERE first_seen_at < ?").run(cutoff);
  return Number(res.changes ?? 0);
}

/**
 * Prospects with no sequence_events/cadence/reply/channel-event activity in
 * the given day window, and not already blocked (an opt-out veto, or a
 * `not_a_fit`/`do_not_contact` stop). The breakup-revive finder's candidate
 * pool: cross-domain by nature (JOINs `prospects`, `sequence_events`,
 * `cadence_state`, `inbox_replies`, `channel_events`), so it stays outside
 * every single-domain store rather than forcing an artificial owner on it.
 */
export function listColdProspects(
  db: Database,
  opts: { minDaysSinceLastEvent: number; maxDaysSinceLastEvent: number; limit?: number },
): Array<{
  id: number;
  name: string | null;
  email: string | null;
  company: string | null;
  linkedin_url: string | null;
  phone: string | null;
  last_event_at: string | null;
}> {
  const sql = `
    SELECT cold.*, strftime('%Y-%m-%dT%H:%M:%fZ', cold.last_event_jd) AS last_event_at
    FROM (
    SELECT p.id, p.name, p.email, p.company, p.linkedin_url, p.phone,
           MAX(s.created_at) AS last_sequence_at,
           MAX(CASE WHEN c.status = 'stopped' AND c.stop_reason IN ('bad_timing', 'other')
                    THEN c.stopped_at END) AS last_revivable_stop_at,
           -- The four sources mix SQLite-form (created_at, stopped_at) and
           -- ISO (received_at, occurred_at) timestamps, so compare them as
           -- julianday numbers, not strings. 0 stands in for "none" because
           -- multi-argument MAX() returns NULL if any argument is NULL.
           NULLIF(MAX(
             COALESCE(MAX(julianday(s.created_at)), 0),
             COALESCE(MAX(CASE WHEN c.status = 'stopped' AND c.stop_reason IN ('bad_timing', 'other')
                               THEN julianday(c.stopped_at) END), 0),
             COALESCE((SELECT MAX(julianday(ir.received_at)) FROM inbox_replies ir
                       WHERE ir.prospect_id = p.id AND coalesce(ir.kind,'human') = 'human'), 0),
             COALESCE((SELECT MAX(julianday(ce.occurred_at)) FROM channel_events ce
                       WHERE ce.prospect_id = p.id AND ce.event_type = 'reply'), 0)
           ), 0) AS last_event_jd
    FROM prospects p
    LEFT JOIN sequence_events s ON s.prospect_id = p.id
    LEFT JOIN cadence_state c ON c.prospect_id = p.id
    WHERE ${contactAllowedClause(db)} AND NOT EXISTS (
      SELECT 1 FROM cadence_state blocked
      WHERE blocked.prospect_id = p.id AND blocked.status = 'stopped'
        AND blocked.stop_reason IN ('not_a_fit', 'do_not_contact')
    )
    GROUP BY p.id
    HAVING last_event_jd IS NOT NULL
      AND julianday('now') - last_event_jd BETWEEN ? AND ?
    ) cold
    ORDER BY cold.last_event_jd ASC
    LIMIT ?
  `;
  return db
    .query(sql)
    .all(opts.minDaysSinceLastEvent, opts.maxDaysSinceLastEvent, opts.limit ?? 50) as never;
}

/** Atomically consume a signed webhook replay key. */
export function consumeWebhookReplay(
  db: Database,
  replayKey: string,
  expiresAt: number,
  now: number,
): boolean {
  return db.transaction(() => {
    db.prepare("DELETE FROM webhook_replays WHERE expires_at < ?").run(now);
    const result = db
      .prepare("INSERT OR IGNORE INTO webhook_replays(replay_key, expires_at) VALUES(?, ?)")
      .run(replayKey, expiresAt);
    return result.changes > 0;
  })();
}

/** Test helper for isolating webhook verification cases. */
export function clearWebhookReplays(db: Database): void {
  db.exec("DELETE FROM webhook_replays");
}

/**
 * Release a previously-consumed replay key. Used when a webhook was
 * verified but downstream processing (ICP filtering, enqueueing) failed
 * before a success response was sent, so the provider's retry of the same
 * signed payload isn't rejected as a replay.
 */
export function releaseWebhookReplay(db: Database, replayKey: string): void {
  db.prepare("DELETE FROM webhook_replays WHERE replay_key = ?").run(replayKey);
}
