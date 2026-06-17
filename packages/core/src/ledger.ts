import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.ts";
import type {
  InterviewRecord,
  ProspectRecord,
  QueueRow,
  QueueStatus,
  ReceiptRecord,
  SequenceEventRecord,
  TriggerRow,
} from "./types.ts";

const DEFAULT_DB_PATH = join(configDir(), "ledger.sqlite");

/** How long a SUCCESSFUL enrichment is reused before refetching (profiles are stable). */
export const ENRICH_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** How long a FAILED enrichment suppresses retries — long enough to ride out an SDK outage, short enough to self-heal. */
export const ENRICH_FAILURE_TTL_MS = 3 * 24 * 3600 * 1000;
/**
 * Hard ceiling on waiting for one enrichProfile call. The platform's enrich
 * tool has been observed HANGING (no error, no result, 5+ min) rather than
 * failing — callers race against this and treat a deadline as a failure.
 */
export const ENRICH_DEADLINE_MS = 120_000;

/**
 * Canonical form for matching prospect emails — trim + lowercase. Inbound reply
 * addresses (cadence inbox poll) are normalized the same way, so a prospect
 * stored from a mixed-case address still matches when they reply. Applied on
 * both store (upsertProspect) and every lookup so the two never diverge.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeParseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A `cadence_state` row joined with its prospect's email/name/company. */
export interface CadenceWithProspect {
  prospect_id: number;
  play_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_due_at: string | null;
  last_polled_at: string | null;
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
}

export class Ledger {
  private db: Database;

  constructor(path: string = DEFAULT_DB_PATH) {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait (don't immediately throw) when another connection holds the write
    // lock — e.g. a background send and a request both opening the ledger, or
    // parallel test workers running first-run migrations against a shared file.
    // Without this, concurrent DDL surfaces as a spurious "database is locked"
    // / "no such table" mid-migration.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        call_type TEXT NOT NULL,
        cost_usd REAL,
        signed_receipt TEXT,
        oneshot_request_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_play ON receipts(play_name);
      CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(created_at);
      -- listReceipts / spend rollups filter (play_name, created_at) together and
      -- sort by created_at; the composite serves both without a separate sort scan.
      CREATE INDEX IF NOT EXISTS idx_receipts_play_created ON receipts(play_name, created_at);
      -- Backs recordReceipt's dedup-by-job-id lookup. Partial (non-null only):
      -- many receipts have no request_id and must NOT collapse together.
      CREATE INDEX IF NOT EXISTS idx_receipts_request ON receipts(oneshot_request_id)
        WHERE oneshot_request_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS prospects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT,
        phone TEXT,
        company TEXT,
        linkedin_url TEXT,
        dossier_json TEXT,
        source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email) WHERE email IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sequence_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospect_id INTEGER NOT NULL,
        play_name TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      -- sequence_events is read by listColdProspects (MAX(created_at) per
      -- prospect), per-play send counts, and cadence scans — all by
      -- prospect_id and/or created_at. Without this it's a full table scan.
      CREATE INDEX IF NOT EXISTS idx_sequence_events_prospect_created ON sequence_events(prospect_id, created_at);
      -- listSequenceEventsForProspectPlay (per-row in /api/cadences toView)
      -- and listSequenceEventsForCadences (bulk variant) both filter on
      -- (prospect_id, play_name) and ORDER BY step_index — composite index
      -- serves both the seek and the sort, no temp B-tree.
      CREATE INDEX IF NOT EXISTS idx_sequence_events_prospect_play ON sequence_events(prospect_id, play_name, step_index);

      CREATE TABLE IF NOT EXISTS interviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person TEXT NOT NULL,
        transcript_path TEXT,
        jtbd TEXT,
        pain_quotes_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cadence_state (
        prospect_id INTEGER NOT NULL,
        play_name TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
        next_due_at TEXT,
        last_polled_at TEXT,
        PRIMARY KEY (prospect_id, play_name)
      );
      CREATE INDEX IF NOT EXISTS idx_cadence_status ON cadence_state(status);
      CREATE INDEX IF NOT EXISTS idx_cadence_next_due ON cadence_state(next_due_at);

      CREATE TABLE IF NOT EXISTS deal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospect_id INTEGER NOT NULL,
        play_name TEXT,
        outcome TEXT NOT NULL,
        amount_usd REAL,
        notes TEXT,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_prospect ON deal_outcomes(prospect_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON deal_outcomes(outcome);
      CREATE INDEX IF NOT EXISTS idx_outcomes_play ON deal_outcomes(play_name);

      CREATE TABLE IF NOT EXISTS target_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        found_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        sent_at TEXT,
        notes TEXT,
        prospect_id INTEGER,
        last_draft_json TEXT,
        last_drafted_at TEXT,
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedupe ON target_queue(play_name, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON target_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_play ON target_queue(play_name);
      -- The /queue page filters by (status, play) together; the composite
      -- serves that pair without falling back to a single-column scan.
      CREATE INDEX IF NOT EXISTS idx_queue_status_play ON target_queue(status, play_name);

      CREATE TABLE IF NOT EXISTS triggers (
        name TEXT PRIMARY KEY,
        last_polled_at TEXT,
        last_run_summary TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT,
        running_started_at TEXT
      );

      CREATE TABLE IF NOT EXISTS enrichment_cache (
        email TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','done','interrupted')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        target_count INTEGER NOT NULL,
        drafted_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        targets_json TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        prospect_emails_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT OR IGNORE INTO schema_version(version) VALUES(6);
    `);

    // Lightweight migrations for installs that pre-date a column.
    this.addColumnIfMissing("prospects", "phone", "TEXT");
    // v5 (2026-04): persist trigger run-state so a server restart doesn't
    // strand fire-and-forget runs as silent stale rows. See
    // sweepStaleRunningTriggers + fireTriggerNow.
    this.addColumnIfMissing("triggers", "running_started_at", "TEXT");
    // v6 (2026-05): persist drafts per target_queue row so the founder can
    // review subject/body/flags after the SSE stream finishes (the /run
    // page itself is ephemeral). See `setQueueDraft` + the persist hook in
    // `apps/server/src/api/run.ts`.
    this.addColumnIfMissing("target_queue", "last_draft_json", "TEXT");
    this.addColumnIfMissing("target_queue", "last_drafted_at", "TEXT");
    // v7 (2026-05): lease column for atomic drain claiming. Two concurrent
    // /api/queue/drain calls used to see the same `approved` rows and both
    // start sending; dequeueApproved now atomically flips this column inside
    // a transaction so each drain sees a disjoint slice. Lease defaults to
    // 15 min — long enough for a slow per-target SDK send, short enough that
    // a crashed drain self-heals without a sweeper.
    this.addColumnIfMissing("target_queue", "drain_claimed_at", "TEXT");
    // v8 (2026-05): persist per-cadence next-step draft so /cadences can
    // preview the 2nd/3rd email before firing (mirrors /queue's
    // last_draft_json). JSON envelope = {subject, body, flags, payload,
    // draftedAt}; cleared on cadence advance.
    this.addColumnIfMissing("cadence_state", "next_step_draft_json", "TEXT");
    this.addColumnIfMissing("cadence_state", "next_step_drafted_at", "TEXT");
    // v9 (2026-06): persist "send in flight" marker so a fire-and-forget
    // cadence-send survives a server restart. The in-memory `inFlightSends`
    // Set was lost on every bun --watch reload, leaving the founder with no
    // loading state AND no email delivered. Claimed via the atomic
    // claimCadenceSendingMarker CAS update; cleared on success (inside
    // advanceCadence) and on failure (catch). sweepStaleCadenceSends on cold
    // boot treats every existing marker as stranded.
    this.addColumnIfMissing("cadence_state", "sending_started_at", "TEXT");
    // v10 (2026-06): Mirror of v9 for the queue Send-draft path. Same bug
    // shape — fire-and-forget background SDK send died on every server
    // restart, leaving the founder with no UI feedback and no record. Wired
    // via claimQueueSendingMarker + sweepStaleQueueSends; auto-cleared by
    // setQueueStatus when the row flips to a terminal state.
    this.addColumnIfMissing("target_queue", "send_started_at", "TEXT");
    // v11 (2026-06): sender rotation. `receipts.sender_identity` records which
    // EmailIdentity (config emailIdentities[].id) sent each email.send — the
    // per-identity daily counter + warm-up first-send date both derive from
    // it. `sender_assignments` pins each prospect (canonical email) to the
    // identity that sent their first touch so follow-ups never switch From
    // address mid-thread. Keyed by email, NOT prospect_id: some sends happen
    // before any prospect row exists (concierge prep email).
    this.addColumnIfMissing("receipts", "sender_identity", "TEXT");
    // v12 (2026-06): negative enrichment caching. NULL/"ok" = success row,
    // "failed" = the enrich SDK job failed for this email — readers skip the
    // retry within ENRICH_FAILURE_TTL_MS so drafts stop re-paying ~70s
    // timeouts for known-bad emails (229 such failures on 2026-06-06..08
    // left 154 queue rows re-enriching on every draft).
    this.addColumnIfMissing("enrichment_cache", "status", "TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sender_assignments (
        email TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_calltype_sender
        ON receipts(call_type, sender_identity, created_at);
    `);
    // v13 (2026-06): persist inbox reply activity. The /inbox composer used to
    // hold the draft + "replied" state only in React useState, so a refresh
    // discarded the draft and reverted the row to a blank composer; the sent
    // body was never stored anywhere (receipts hold metadata only). Keyed by
    // thread_key = Gmail thread_id (else the email id) so follow-ups in a
    // thread share one draft + sent history. `inbox_drafts` is the single
    // mutable draft per thread (cleared on send); `inbox_sent` is the
    // append-only history of replies actually sent (we allow replying again).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_drafts (
        thread_key       TEXT PRIMARY KEY,
        inbound_email_id TEXT NOT NULL,
        to_email         TEXT NOT NULL,
        subject          TEXT,
        identity_id      TEXT,
        body             TEXT NOT NULL,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS inbox_sent (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_key  TEXT NOT NULL,
        to_email    TEXT NOT NULL,
        subject     TEXT,
        body        TEXT NOT NULL,
        identity_id TEXT,
        request_id  TEXT,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_sent_thread
        ON inbox_sent(thread_key, sent_at);
    `);
    // v14 (2026-06): persist the last cadence send FAILURE so the /cadences row
    // can show "send failed · retrying" instead of looking identical to a row
    // that's merely waiting on the founder. A failed send doesn't advance the
    // cadence, so without this the founder can't tell "blocked upstream" from
    // "waiting on me". Set by recordCadenceSendError on a dispatch throw;
    // cleared by advanceCadence / setCadenceStatus on any forward progress.
    this.addColumnIfMissing("cadence_state", "last_send_error", "TEXT");
    this.addColumnIfMissing("cadence_state", "last_send_error_at", "TEXT");
    // v15 (2026-06): persist candidates whose paid contact-resolution failed on
    // a TRANSIENT platform error (the OneShot outage), so a finder doesn't lose
    // them — re-scannable finders self-heal, but time-windowed ones (luma,
    // show-hn) can't re-discover an expired source. `raw_json` holds whatever
    // the finder's registered handler needs to re-resolve + enqueue. The
    // scheduler retry pass drains this once the platform recovers; the
    // (play_name, dedupe_key) PK also serves as the de-dup key against re-scan.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_resolution (
        play_name       TEXT NOT NULL,
        dedupe_key      TEXT NOT NULL,
        source          TEXT NOT NULL,
        raw_json        TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (play_name, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_resolution_seen
        ON pending_resolution(first_seen_at);
    `);
  }

  /**
   * CAS-claim a timestamp marker on a single row. Returns true when the row's
   * marker was NULL (or older than `staleCutoffIso` when provided) and we set
   * it to `startedAtIso`; false when another caller already holds the claim.
   *
   * Shared by every in-flight marker in the ledger: triggers.running_started_at,
   * cadence_state.sending_started_at, target_queue.send_started_at. Each domain
   * just supplies its own table + primary-key WHERE fragment.
   *
   * Identifier validation (table + column) mirrors `addColumnIfMissing` —
   * SQLite has no parameter binding for table/column names, so we whitelist
   * to bare ASCII to slam the door on any injection vector.
   */
  private claimMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    this.assertSafeIdentifiers(opts.table, opts.column);
    const staleClause = opts.staleCutoffIso
      ? ` AND (${opts.column} IS NULL OR ${opts.column} < ?)`
      : ` AND ${opts.column} IS NULL`;
    const args = opts.staleCutoffIso
      ? [opts.startedAtIso, ...opts.pkeyValues, opts.staleCutoffIso]
      : [opts.startedAtIso, ...opts.pkeyValues];
    const result = this.db
      .prepare(
        `UPDATE ${opts.table}
         SET ${opts.column} = ?
         WHERE ${opts.pkeyWhere}${staleClause}`,
      )
      .run(...(args as never[]));
    return result.changes > 0;
  }

  /**
   * Release a timestamp marker (set to NULL). Idempotent — no-op if the row
   * doesn't exist or the column is already NULL.
   */
  private clearMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
  }): void {
    this.assertSafeIdentifiers(opts.table, opts.column);
    this.db
      .prepare(`UPDATE ${opts.table} SET ${opts.column} = NULL WHERE ${opts.pkeyWhere}`)
      .run(...(opts.pkeyValues as never[]));
  }

  private assertSafeIdentifiers(table: string, column: string): void {
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!ident.test(table) || !ident.test(column)) {
      throw new Error(`unsafe identifier in marker helper: ${table}.${column}`);
    }
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    // Defense-in-depth: SQLite has no parameter binding for table/column/type
    // names, so we must validate. Whitelist to bare ASCII identifiers only.
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!ident.test(table) || !ident.test(column)) {
      throw new Error(`unsafe identifier in addColumnIfMissing: ${table}.${column}`);
    }
    if (!/^[A-Z][A-Z0-9_ ]*$/.test(type)) {
      throw new Error(`unsafe column type in addColumnIfMissing: ${type}`);
    }
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  enrollCadence(input: { prospectId: number; playName: string; nextDueAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO cadence_state(prospect_id, play_name, current_step, status, next_due_at)
         VALUES(?, ?, 0, 'active', ?)
         ON CONFLICT(prospect_id, play_name) DO UPDATE SET
           status = 'active',
           next_due_at = excluded.next_due_at,
           last_polled_at = NULL,
           last_send_error = NULL,
           last_send_error_at = NULL`,
      )
      .run(input.prospectId, input.playName, input.nextDueAt);
  }

  listActiveCadences(opts: { dueByIso?: string } = {}): CadenceWithProspect[] {
    const where: string[] = ["c.status = 'active'"];
    const args: unknown[] = [];
    if (opts.dueByIso) {
      where.push("(c.next_due_at IS NULL OR c.next_due_at <= ?)");
      args.push(opts.dueByIso);
    }
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all(...(args as never[])) as never;
  }

  listAllCadences(): CadenceWithProspect[] {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all() as never;
  }

  /**
   * Single cadence (joined with its prospect) by (prospect_id, play_name) — an
   * index seek on the `cadence_state` PRIMARY KEY. Replaces the O(n)
   * `listAllCadences().find(...)` scan callers used to do per row.
   */
  getCadence(prospectId: number, playName: string): CadenceWithProspect | null {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE c.prospect_id = ? AND c.play_name = ?
    `;
    return (this.db.query(sql).get(prospectId, playName) as CadenceWithProspect) ?? null;
  }

  /** All cadences for one prospect — index seek on cadence_state.prospect_id (PK prefix). */
  listCadencesForProspect(prospectId: number): CadenceWithProspect[] {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE c.prospect_id = ?
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all(prospectId) as never;
  }

  advanceCadence(input: {
    prospectId: number;
    playName: string;
    newStep: number;
    nextDueAt: string | null;
  }): void {
    // Also clear any persisted next-step draft AND the sending marker — the
    // draft was for the OLD next step (stale after advance), and a successful
    // advance means the in-flight send for this row is done. /cadences will
    // surface a fresh "no preview yet" state.
    // A successful advance also clears any prior send-failure marker (the send
    // that just advanced us obviously succeeded).
    this.db
      .prepare(
        `UPDATE cadence_state
         SET current_step = ?, next_due_at = ?, last_polled_at = datetime('now'),
             next_step_draft_json = NULL, next_step_drafted_at = NULL,
             sending_started_at = NULL,
             last_send_error = NULL, last_send_error_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.newStep, input.nextDueAt, input.prospectId, input.playName);
  }

  /**
   * Record the last cadence send FAILURE so /cadences can show the row is
   * blocked upstream (vs. waiting on the founder). Cleared by advanceCadence /
   * setCadenceStatus on any forward progress. No-op if the row is gone.
   */
  recordCadenceSendError(input: { prospectId: number; playName: string; error: string }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET last_send_error = ?, last_send_error_at = datetime('now')
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.error.slice(0, 200), input.prospectId, input.playName);
  }

  setCadenceStatus(input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed";
  }): void {
    // Non-active terminal states clear the persisted draft AND any send
    // marker — a replied / breakup / completed cadence shouldn't have a
    // sendable preview hanging around or a stuck "sending" flag. A reply /
    // breakup / completion also clears any stale send-failure marker.
    this.db
      .prepare(
        `UPDATE cadence_state
         SET status = ?,
             next_step_draft_json = CASE WHEN ? = 'active' THEN next_step_draft_json ELSE NULL END,
             next_step_drafted_at = CASE WHEN ? = 'active' THEN next_step_drafted_at ELSE NULL END,
             sending_started_at = CASE WHEN ? = 'active' THEN sending_started_at ELSE NULL END,
             last_send_error = CASE WHEN ? = 'active' THEN last_send_error ELSE NULL END,
             last_send_error_at = CASE WHEN ? = 'active' THEN last_send_error_at ELSE NULL END
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(
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

  setCadenceDraft(input: {
    prospectId: number;
    playName: string;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      payload: unknown;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(
        `UPDATE cadence_state
         SET next_step_draft_json = ?, next_step_drafted_at = ?
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(json, draftedAtIso, input.prospectId, input.playName);
  }

  getCadenceDraft(input: { prospectId: number; playName: string }): {
    subject: string;
    body: string;
    flags: string[];
    payload: unknown;
    draftedAt: string;
  } | null {
    const row = this.db
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

  clearCadenceDraft(input: { prospectId: number; playName: string }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET next_step_draft_json = NULL, next_step_drafted_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.prospectId, input.playName);
  }

  /**
   * Save (or overwrite) the single in-progress draft for an inbox thread.
   * Backs the /inbox composer's debounced auto-save so a refresh or navigation
   * away no longer discards the draft. Keyed by thread_key (see `inboxThreadKey`
   * in shared-types) — Gmail thread_id, else the email id.
   */
  upsertInboxDraft(input: {
    threadKey: string;
    inboundEmailId: string;
    toEmail: string;
    subject: string;
    identityId: string | null;
    body: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO inbox_drafts(thread_key, inbound_email_id, to_email, subject, identity_id, body, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET
           inbound_email_id = excluded.inbound_email_id,
           to_email = excluded.to_email,
           subject = excluded.subject,
           identity_id = excluded.identity_id,
           body = excluded.body,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.threadKey,
        input.inboundEmailId,
        input.toEmail,
        input.subject,
        input.identityId,
        input.body,
        new Date().toISOString(),
      );
  }

  clearInboxDraft(threadKey: string): void {
    this.db.prepare(`DELETE FROM inbox_drafts WHERE thread_key = ?`).run(threadKey);
  }

  /**
   * Record a reply that was actually sent (append to history) and clear the
   * thread's draft in one transaction. History is append-only because we let
   * the founder reply again on the same thread.
   */
  recordInboxSent(input: {
    threadKey: string;
    toEmail: string;
    subject: string;
    body: string;
    identityId: string | null;
    requestId: string | null;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO inbox_sent(thread_key, to_email, subject, body, identity_id, request_id, sent_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.threadKey,
          input.toEmail,
          input.subject,
          input.body,
          input.identityId,
          input.requestId,
          new Date().toISOString(),
        );
      this.db.prepare(`DELETE FROM inbox_drafts WHERE thread_key = ?`).run(input.threadKey);
    })();
  }

  /**
   * Bulk-read persisted reply state for the inbox list route: the saved draft
   * (if any) plus the sent history per thread. Mirrors the `byEmail` map the
   * list route builds for cadence context — one read, indexed by thread_key.
   */
  getInboxThreads(): Map<
    string,
    { draftBody: string | null; sent: { body: string; sentAt: string }[] }
  > {
    const map = new Map<
      string,
      { draftBody: string | null; sent: { body: string; sentAt: string }[] }
    >();
    const ensure = (key: string) => {
      let entry = map.get(key);
      if (!entry) {
        entry = { draftBody: null, sent: [] };
        map.set(key, entry);
      }
      return entry;
    };
    const drafts = this.db
      .query(`SELECT thread_key AS k, body AS b FROM inbox_drafts`)
      .all() as Array<{ k: string; b: string }>;
    for (const d of drafts) ensure(d.k).draftBody = d.b;
    const sent = this.db
      .query(`SELECT thread_key AS k, body AS b, sent_at AS t FROM inbox_sent ORDER BY sent_at ASC`)
      .all() as Array<{ k: string; b: string; t: string }>;
    for (const s of sent) ensure(s.k).sent.push({ body: s.b, sentAt: s.t });
    return map;
  }

  /**
   * Atomic claim of the sending marker. Returns `true` when the row had a
   * NULL `sending_started_at` and the marker was set; `false` if another
   * caller already holds the claim. Mirrors triggers' `markTriggerRunning`
   * CAS pattern so two concurrent Send clicks can't double-fire.
   *
   * `staleCutoffIso` (optional): allows a fresh click to reclaim a marker
   * whose `sending_started_at` is older than the cutoff — for the case where
   * a previous send was stranded by a server restart and the cold-boot
   * sweeper hasn't cleared it yet. Without this, the row would 409 every
   * retry until the next boot sweep.
   */
  claimCadenceSendingMarker(input: {
    prospectId: number;
    playName: string;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.claimMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
      startedAtIso: input.startedAtIso,
      ...(input.staleCutoffIso ? { staleCutoffIso: input.staleCutoffIso } : {}),
    });
  }

  /** Release the sending marker for this cadence (sets sending_started_at = NULL). */
  clearCadenceSendingMarker(input: { prospectId: number; playName: string }): void {
    this.clearMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
    });
  }

  /**
   * Sweep cadence rows whose `sending_started_at` is older than the cutoff
   * (or any non-null value when `staleAgeMs` is 0 — cold-boot semantics).
   * For each match, classify by whether a `sequence_events` row for the
   * (prospect, play, current_step) already exists:
   *   - event present → the send actually went out; clear the marker only.
   *   - event absent  → the send was stranded (server died mid-call); clear
   *     the marker but leave the draft so the founder can re-click Send.
   * Returns the swept rows so the caller can log them.
   *
   * Pure-ish (takes `now` + `maxAgeMs` as args) — tests can drive both
   * "fresh markers spared" and "stale markers swept" without faking the clock.
   */
  sweepStaleCadenceSends(input: { now: Date; maxAgeMs: number }): Array<{
    prospectId: number;
    playName: string;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
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
    const checkEvent = this.db.prepare(
      `SELECT 1 FROM sequence_events
       WHERE prospect_id = ? AND play_name = ? AND step_index = ?
         AND status IN ('sent','delivered','replied')
       LIMIT 1`,
    );
    const clear = this.db.prepare(
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

  findProspectByEmail(email: string): { id: number } | null {
    return (
      (this.db.query("SELECT id FROM prospects WHERE email = ?").get(canonEmail(email)) as {
        id: number;
      }) ?? null
    );
  }

  /** Full prospect record by email — used to attach name/company to inbox replies. */
  getProspectByEmail(email: string): ProspectRecord | null {
    return (
      (this.db
        .query("SELECT * FROM prospects WHERE email = ?")
        .get(canonEmail(email)) as ProspectRecord) ?? null
    );
  }

  /** Full prospect record by id (PK seek). Avoids loading every prospect to find one. */
  getProspectById(id: number): ProspectRecord | null {
    return (
      (this.db.query("SELECT * FROM prospects WHERE id = ?").get(id) as ProspectRecord) ?? null
    );
  }

  /**
   * Cached enrichProfile result for an email (profiles are stable; reused
   * with a TTL). `status` is NULL/"ok" for success rows, "failed" for
   * negative entries (the SDK job failed — readers skip re-attempting within
   * ENRICH_FAILURE_TTL_MS instead of paying the ~70s call again).
   */
  getCachedEnrichment(
    email: string,
  ): { result_json: string; fetched_at: string; status: string | null } | null {
    return (
      (this.db
        .query("SELECT result_json, fetched_at, status FROM enrichment_cache WHERE email = ?")
        .get(email) as { result_json: string; fetched_at: string; status: string | null }) ?? null
    );
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    // status reset to NULL: a fresh success must clear any prior "failed"
    // marker — luma/_repo-pipeline write success rows through this method
    // without knowing about negative entries.
    this.db
      .prepare(
        `INSERT INTO enrichment_cache(email, result_json, fetched_at, status)
         VALUES(?, ?, ?, NULL)
         ON CONFLICT(email) DO UPDATE SET
           result_json = excluded.result_json,
           fetched_at = excluded.fetched_at,
           status = NULL`,
      )
      .run(email, resultJson, new Date().toISOString());
  }

  /** Negative cache entry: the enrichment SDK job failed for this email. */
  setCachedEnrichmentFailure(email: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO enrichment_cache(email, result_json, fetched_at, status)
         VALUES(?, ?, ?, 'failed')
         ON CONFLICT(email) DO UPDATE SET
           result_json = excluded.result_json,
           fetched_at = excluded.fetched_at,
           status = 'failed'`,
      )
      .run(
        email,
        JSON.stringify({ failed: true, message: message.slice(0, 300) }),
        new Date().toISOString(),
      );
  }

  recordReceipt(input: {
    playName: string;
    callType: string;
    /** Per-call USD cost. Every wrapper in `oneshot.ts` reads `result.cost`
     *  from the SDK response (declared on every result type in
     *  `@oneshot-agent/sdk@0.15.2+`) and forwards it here. NULL in the
     *  column when undefined — visible signal that the SDK omitted cost. */
    costUsd?: number;
    signedReceipt?: unknown;
    oneshotRequestId?: string;
    /** EmailIdentity id for email.send receipts — drives per-identity daily caps. */
    senderIdentity?: string;
  }): number {
    // Idempotent on the job id: the SDK's idempotency replay returns the
    // ORIGINAL request_id when a timed-out/double-fired send is retried, and a
    // Gmail message id is unique per send — so a non-null request_id already in
    // the table means "same underlying send". Return the existing receipt
    // instead of inserting a duplicate that would double-count spend and caps.
    // Null request_ids (cache hits, SDK omissions) are distinct events and skip
    // this — they must never collapse together.
    if (input.oneshotRequestId) {
      const existing = this.db
        .query("SELECT id FROM receipts WHERE oneshot_request_id = ?")
        .get(input.oneshotRequestId) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    // Number.isFinite guard rejects undefined / Infinity / NaN — those land
    // as NULL in the column, NOT silently distorted into a number.
    const costUsd =
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null;
    const stmt = this.db.prepare(`
      INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, sender_identity)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.playName,
      input.callType,
      costUsd,
      input.signedReceipt ? JSON.stringify(input.signedReceipt) : null,
      input.oneshotRequestId ?? null,
      input.senderIdentity ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getSenderAssignment(email: string): string | null {
    const row = this.db
      .query("SELECT identity_id FROM sender_assignments WHERE email = ?")
      .get(canonEmail(email)) as { identity_id: string } | undefined;
    return row?.identity_id ?? null;
  }

  /**
   * Pin a prospect email to a sending identity. INSERT OR IGNORE + read-back
   * makes concurrent first-touches race-safe: both callers end up using the
   * single winning assignment instead of splitting the thread across senders.
   */
  assignSender(email: string, identityId: string): string {
    const canon = canonEmail(email);
    this.db
      .prepare("INSERT OR IGNORE INTO sender_assignments(email, identity_id) VALUES(?, ?)")
      .run(canon, identityId);
    return this.getSenderAssignment(canon) ?? identityId;
  }

  /**
   * Sends by an identity since `sinceUtcSqlite`. The timestamp MUST be in
   * SQLite datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC) — receipts
   * default created_at to that format, and an ISO string with its 'T'
   * separator compares GREATER than any same-day SQLite timestamp, silently
   * excluding today's rows.
   */
  countEmailSendsSince(identityId: string, sinceUtcSqlite: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM receipts
         WHERE call_type = 'email.send' AND sender_identity = ? AND created_at >= ?`,
      )
      .get(identityId, sinceUtcSqlite) as { n: number };
    return row.n;
  }

  /**
   * Did we ever email this address pre-rotation? Used to lazy-pin legacy
   * prospects (e.g. in-flight cadences) to the legacy identity instead of
   * letting the rotation picker move their thread to a new From address.
   */
  hasPriorEmailSend(email: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM sequence_events se
         JOIN prospects p ON p.id = se.prospect_id
         WHERE p.email = ? AND se.channel = 'email'
           AND se.status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(canonEmail(email)) as 1 | undefined;
    return row != null;
  }

  /** First email.send by this identity (warm-up ramp anchor). SQLite-format UTC or null. */
  firstEmailSendAt(identityId: string): string | null {
    const row = this.db
      .query(
        `SELECT MIN(created_at) AS first FROM receipts
         WHERE call_type = 'email.send' AND sender_identity = ?`,
      )
      .get(identityId) as { first: string | null };
    return row.first;
  }

  getReceipt(id: number): ReceiptRecord | null {
    return (this.db.query("SELECT * FROM receipts WHERE id = ?").get(id) as ReceiptRecord) ?? null;
  }

  listReceipts(
    opts: { playName?: string; sinceIso?: string; limit?: number } = {},
  ): ReceiptRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `SELECT * FROM receipts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return this.db.query(sql).all(...(args as never[])) as ReceiptRecord[];
  }

  upsertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    // Store the canonical (lowercased) email so reply matching — which
    // normalizes the inbound from-address the same way — always lands.
    const email = input.email ? canonEmail(input.email) : null;
    if (email) {
      const existing = this.db.query("SELECT id FROM prospects WHERE email = ?").get(email) as
        | { id: number }
        | undefined;
      if (existing) return existing.id;
    }
    const stmt = this.db.prepare(`
      INSERT INTO prospects(name, email, phone, company, linkedin_url, dossier_json, source)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.name ?? null,
      email,
      (input as { phone?: string | null }).phone ?? null,
      input.company ?? null,
      input.linkedin_url ?? null,
      input.dossier_json ?? null,
      input.source ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  recordOutcome(input: {
    prospectId: number;
    playName?: string;
    outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted";
    amountUsd?: number;
    notes?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO deal_outcomes(prospect_id, play_name, outcome, amount_usd, notes)
      VALUES(?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.prospectId,
      input.playName ?? null,
      input.outcome,
      input.amountUsd ?? null,
      input.notes ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  countOutcomes(
    opts: {
      sinceIso?: string;
      playName?: string;
      outcome?: string;
    } = {},
  ): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("recorded_at >= ?");
      args.push(opts.sinceIso);
    }
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.outcome) {
      where.push("outcome = ?");
      args.push(opts.outcome);
    }
    const sql = `SELECT COUNT(*) AS n FROM deal_outcomes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  outcomesByPlay(opts: { sinceIso?: string } = {}): Array<{
    play_name: string | null;
    meetings: number;
    sqls: number;
    won: number;
    lost: number;
    ghosted: number;
  }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("recorded_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT
        play_name,
        SUM(CASE WHEN outcome = 'meeting_booked' THEN 1 ELSE 0 END) AS meetings,
        SUM(CASE WHEN outcome = 'sql_qualified' THEN 1 ELSE 0 END) AS sqls,
        SUM(CASE WHEN outcome = 'deal_won' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN outcome = 'deal_lost' THEN 1 ELSE 0 END) AS lost,
        SUM(CASE WHEN outcome = 'ghosted' THEN 1 ELSE 0 END) AS ghosted
      FROM deal_outcomes
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
      ORDER BY play_name ASC NULLS LAST
    `;
    return this.db.query(sql).all(...(args as never[])) as never;
  }

  listColdProspects(opts: {
    minDaysSinceLastEvent: number;
    maxDaysSinceLastEvent: number;
    limit?: number;
  }): Array<{
    id: number;
    name: string | null;
    email: string | null;
    company: string | null;
    linkedin_url: string | null;
    phone: string | null;
    last_event_at: string | null;
  }> {
    const sql = `
      SELECT p.id, p.name, p.email, p.company, p.linkedin_url, p.phone, MAX(s.created_at) AS last_event_at
      FROM prospects p
      LEFT JOIN sequence_events s ON s.prospect_id = p.id
      GROUP BY p.id
      HAVING last_event_at IS NOT NULL
        AND julianday('now') - julianday(last_event_at) BETWEEN ? AND ?
      ORDER BY last_event_at ASC
      LIMIT ?
    `;
    return this.db
      .query(sql)
      .all(opts.minDaysSinceLastEvent, opts.maxDaysSinceLastEvent, opts.limit ?? 50) as never;
  }

  recordSequenceEvent(input: {
    prospectId: number;
    playName: string;
    stepIndex: number;
    channel: SequenceEventRecord["channel"];
    status: SequenceEventRecord["status"];
    metadata?: unknown;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.prospectId,
      input.playName,
      input.stepIndex,
      input.channel,
      input.status,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * True when a (prospect, play, step) already has a terminal-sent sequence_event
   * — i.e. that step's email/SMS/voice already went out. Used by the cadence
   * engine as a pre-dispatch guard so a crash between `recordSequenceEvent` and
   * `advanceCadence` (which leaves `current_step` lagging the sent step) can't
   * cause a re-send on the next due tick. Same status predicate as the stale-send
   * sweep below.
   */
  hasSentSequenceEvent(prospectId: number, playName: string, stepIndex: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND step_index = ?
             AND status IN ('sent','delivered','replied')
           LIMIT 1`,
        )
        .get(prospectId, playName, stepIndex) != null
    );
  }

  /**
   * Mark a prospect's latest sent step `replied` (the reply-rate signal behind
   * the home dashboard + measure/CAC, which all read `status='replied'` from
   * sequence_events — nothing else writes it). A reply is modelled as a state
   * transition of an existing sent step, NOT a new event, so `sent` counts that
   * read `status IN ('sent','delivered','replied')` stay correct.
   *
   * Idempotent and safe to call on every poll: the `NOT EXISTS` guard means once
   * any step for this (prospect, play) is `replied`, further calls are no-ops —
   * so it never walks backwards marking earlier steps too. Returns true on the
   * one call that flips a row.
   */
  markLatestStepReplied(input: { prospectId: number; playName: string }): boolean {
    const result = this.db
      .prepare(
        `UPDATE sequence_events SET status = 'replied'
         WHERE id = (
           SELECT id FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND status IN ('sent','delivered')
           ORDER BY created_at DESC, id DESC LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND status = 'replied'
         )`,
      )
      .run(input.prospectId, input.playName, input.prospectId, input.playName);
    return result.changes > 0;
  }

  /**
   * Single source of truth for "a prospect replied to a cadence". Atomically
   * writes BOTH planes so they can't drift:
   *  - control plane: `cadence_state.status='replied'` (stops further sends), and
   *  - analytics plane: the latest sent step → `replied` in sequence_events
   *    (the event log behind every reply metric — home, CAC, weekly review).
   * The two surfaces read different tables on purpose (a lifetime status snapshot
   * vs a 7-day count), but a reply now updates them together in one transaction.
   *
   * Reads the current status inside the transaction and acts on it, so callers
   * just hand it a (prospect, play): an `active` cadence flips + records; an
   * already-`replied` one only backfills the event (idempotent); a terminal
   * `breakup`/`completed` cadence is left untouched. Returns `newlyReplied` —
   * true only on the active→replied transition, so callers count a reply once.
   */
  recordCadenceReply(input: { prospectId: number; playName: string }): { newlyReplied: boolean } {
    return this.db.transaction(() => {
      const cad = this.getCadence(input.prospectId, input.playName);
      const newlyReplied = cad?.status === "active";
      if (newlyReplied) {
        this.setCadenceStatus({
          prospectId: input.prospectId,
          playName: input.playName,
          status: "replied",
        });
      }
      if (newlyReplied || cad?.status === "replied") {
        this.markLatestStepReplied({
          prospectId: input.prospectId,
          playName: input.playName,
        });
      }
      return { newlyReplied };
    })();
  }

  listSequenceEventsForProspectPlay(prospectId: number, playName: string): SequenceEventRecord[] {
    return this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE prospect_id = ? AND play_name = ?
           AND status IN ('sent','delivered','replied')
         ORDER BY step_index ASC, id ASC`,
      )
      .all(prospectId, playName) as SequenceEventRecord[];
  }

  /**
   * Bulk variant of listSequenceEventsForProspectPlay: one SQL round-trip for
   * many (prospect_id, play_name) pairs. Returns a Map keyed by
   * `${prospect_id}|${play_name}` so callers can index in O(1). The
   * per-key arrays preserve the same (step_index ASC, id ASC) ordering the
   * single-row method returns. Empty input → empty map (no query).
   *
   * Index-served by idx_sequence_events_prospect_play; the OR-chain is
   * expanded into per-pair index seeks by the query planner.
   */
  listSequenceEventsForCadences(
    pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
  ): Map<string, SequenceEventRecord[]> {
    const map = new Map<string, SequenceEventRecord[]>();
    if (pairs.length === 0) return map;
    const conditions = pairs.map(() => "(prospect_id = ? AND play_name = ?)").join(" OR ");
    const args: unknown[] = [];
    for (const p of pairs) {
      args.push(p.prospectId, p.playName);
    }
    const rows = this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE (${conditions})
           AND status IN ('sent','delivered','replied')
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

  recordInterview(input: Omit<InterviewRecord, "id" | "created_at">): number {
    const stmt = this.db.prepare(`
      INSERT INTO interviews(person, transcript_path, jtbd, pain_quotes_json)
      VALUES(?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.person,
      input.transcript_path,
      input.jtbd,
      input.pain_quotes_json,
    );
    return Number(result.lastInsertRowid);
  }

  countSends(opts: { playName?: string } = {}): number {
    const sql = opts.playName
      ? "SELECT COUNT(*) AS n FROM sequence_events WHERE play_name = ? AND status IN ('sent', 'delivered', 'replied')"
      : "SELECT COUNT(*) AS n FROM sequence_events WHERE status IN ('sent', 'delivered', 'replied')";
    const args = opts.playName ? [opts.playName] : [];
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  spendByPlay(
    opts: { sinceIso?: string } = {},
  ): Array<{ play_name: string; calls: number; total_usd: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT play_name, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS total_usd
      FROM receipts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
      ORDER BY total_usd DESC, calls DESC
    `;
    return this.db.query(sql).all(...(args as never[])) as Array<{
      play_name: string;
      calls: number;
      total_usd: number;
    }>;
  }

  eventsByPlay(opts: { sinceIso?: string } = {}): Array<{
    play_name: string;
    sent: number;
    delivered: number;
    replied: number;
    bounced: number;
  }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT
        play_name,
        SUM(CASE WHEN status IN ('sent', 'delivered', 'replied') THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status IN ('delivered', 'replied') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced
      FROM sequence_events
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
    `;
    return this.db.query(sql).all(...(args as never[])) as Array<{
      play_name: string;
      sent: number;
      delivered: number;
      replied: number;
      bounced: number;
    }>;
  }

  totalSpendUsd(opts: { sinceIso?: string; playName?: string } = {}): number {
    const where: string[] = ["cost_usd IS NOT NULL"];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM receipts WHERE ${where.join(" AND ")}`;
    return (this.db.query(sql).get(...(args as never[])) as { total: number } | null)?.total ?? 0;
  }

  // ── target_queue ────────────────────────────────────────────────────────────

  /**
   * Insert a row into target_queue. Returns the new id, or null if a row with
   * the same (play_name, dedupe_key) already exists.
   */
  enqueueTarget(input: {
    playName: string;
    payload: unknown;
    dedupeKey: string;
    source: string;
    notes?: string;
    /**
     * Status to insert with. Defaults to "pending" (the normal review path).
     * Pass "rejected" to record an auto-drop (e.g. ICP filter said no) so the
     * founder can see what was filtered out and override if needed.
     */
    initialStatus?: QueueStatus;
  }): number | null {
    try {
      const status = input.initialStatus ?? "pending";
      const reviewedAt = status === "pending" ? null : new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, reviewed_at, notes)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.playName,
          JSON.stringify(input.payload),
          input.dedupeKey,
          input.source,
          status,
          reviewedAt,
          input.notes ?? null,
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      // Unique constraint violation = already queued; return null to signal dedupe.
      const msg = (err as Error).message ?? "";
      if (msg.includes("UNIQUE constraint failed")) return null;
      throw err;
    }
  }

  isQueueDuplicate(playName: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM target_queue WHERE play_name = ? AND dedupe_key = ?")
      .get(playName, dedupeKey);
    return row !== null && row !== undefined;
  }

  /**
   * Persist a candidate whose paid resolution hit a transient platform error,
   * so the retry pass can complete it later (and re-scan won't re-create it).
   * Idempotent: a re-discovered candidate keeps its original first_seen_at and
   * attempt count (the retry pass owns attempt bookkeeping).
   */
  upsertPendingResolution(input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_resolution(play_name, dedupe_key, source, raw_json)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(play_name, dedupe_key) DO UPDATE SET
           source = excluded.source,
           raw_json = excluded.raw_json`,
      )
      .run(input.playName, input.dedupeKey, input.source, JSON.stringify(input.raw));
  }

  /** True when (play, dedupeKey) is awaiting retry — finders OR this into their dedup. */
  isPendingResolution(playName: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
      .get(playName, dedupeKey);
    return row !== null && row !== undefined;
  }

  /** Pending rows (optionally one play), oldest first, for the retry pass. */
  listPendingResolution(opts?: { playName?: string; limit?: number }): Array<{
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
    const q = this.db.query(sql);
    return (opts?.playName ? q.all(opts.playName) : q.all()) as never;
  }

  /** Mark a pending row as just-attempted (bumps attempts + last_attempt_at). */
  markPendingResolutionAttempted(playName: string, dedupeKey: string): void {
    this.db
      .prepare(
        `UPDATE pending_resolution
         SET attempts = attempts + 1, last_attempt_at = datetime('now')
         WHERE play_name = ? AND dedupe_key = ?`,
      )
      .run(playName, dedupeKey);
  }

  deletePendingResolution(playName: string, dedupeKey: string): void {
    this.db
      .prepare("DELETE FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
      .run(playName, dedupeKey);
  }

  /**
   * Purge pending rows older than maxAgeMs (permanently-unresolvable or an
   * aged-out time-windowed source) so their dedupe_key frees for future
   * re-discovery and the table doesn't silt. Returns the number removed.
   */
  sweepStalePendingResolution(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const res = this.db
      .prepare("DELETE FROM pending_resolution WHERE first_seen_at < ?")
      .run(cutoff);
    return Number(res.changes ?? 0);
  }

  /**
   * Cross-play dedup (finder side): is this email already sitting in a
   * non-terminal queue row under ANY play? Catches the window where the same
   * person is queued under two plays before either has sent (so no prospect row
   * exists yet for findProspectByEmail to catch). Terminal rows
   * (sent/rejected/expired) are excluded so they never block future work.
   * Matches both `email` (most plays) and `founderEmail` (show-hn-style).
   */
  isEmailPendingInQueue(email: string): boolean {
    // Case-insensitive to match findProspectByEmail/upsertProspect, which store
    // and look up the canonical (lowercased) email — otherwise a casing mismatch
    // between two finders would slip a dup through. LOWER() on the JSON side,
    // canonEmail() on the arg.
    const row = this.db
      .query(
        `SELECT 1 FROM target_queue
         WHERE status IN ('pending','approved')
           AND (LOWER(json_extract(payload_json, '$.email')) = ?1
                OR LOWER(json_extract(payload_json, '$.founderEmail')) = ?1)
         LIMIT 1`,
      )
      .get(canonEmail(email));
    return row !== null && row !== undefined;
  }

  /**
   * Cross-play dedup (send side): has this prospect already received an initial
   * (step-0) touch under ANY play? The authoritative guard against first-touching
   * the same person twice. Mirrors the step-0 existence check in
   * sweepStaleCadenceSends. Note: deliberate re-engagement (breakup-revive)
   * bypasses this via sendDraftedEmail's `allowRecontact`.
   */
  prospectHasFirstTouch(prospectId: number): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM sequence_events
         WHERE prospect_id = ? AND step_index = 0
           AND status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(prospectId);
    return row !== null && row !== undefined;
  }

  /**
   * Look up a queue row by its (play_name, dedupe_key) — the unique pair.
   * Used by the SSE /run endpoint to map drafts back to the originating
   * row so we can persist `last_draft_json`. Returns null when absent.
   */
  getQueueRowByDedupe(playName: string, dedupeKey: string): QueueRow | null {
    return (
      (this.db
        .query("SELECT * FROM target_queue WHERE play_name = ? AND dedupe_key = ?")
        .get(playName, dedupeKey) as QueueRow) ?? null
    );
  }

  listQueue(opts: { playName?: string; status?: QueueStatus; limit?: number } = {}): QueueRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    const sql = `
      SELECT * FROM target_queue
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY found_at DESC
      LIMIT ?
    `;
    args.push(opts.limit ?? 200);
    return this.db.query(sql).all(...(args as never[])) as QueueRow[];
  }

  getQueueRow(id: number): QueueRow | null {
    return (this.db.query("SELECT * FROM target_queue WHERE id = ?").get(id) as QueueRow) ?? null;
  }

  setQueueStatus(input: { id: number; status: QueueStatus; notes?: string }): void {
    const now = new Date().toISOString();
    // Every status transition clears `send_started_at` — a deliberate status
    // change means the previous "sending" attempt (if any) is settled. Terminal
    // states (sent/rejected/expired) clear naturally. Approved → approved
    // doesn't need to preserve a marker (caller re-claims on the next send).
    if (input.status === "sent") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, sent_at = ?, reviewed_at = COALESCE(reviewed_at, ?), send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, now, input.notes, input.id]
            : [input.status, now, now, input.id]),
        );
    } else if (input.status === "approved" || input.status === "rejected") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, reviewed_at = ?, send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, input.notes, input.id]
            : [input.status, now, input.id]),
        );
    } else {
      this.db
        .prepare(`UPDATE target_queue SET status = ?, send_started_at = NULL WHERE id = ?`)
        .run(input.status, input.id);
    }
  }

  /**
   * Atomic claim of the queue-send marker on `target_queue.send_started_at`.
   * Mirrors `claimCadenceSendingMarker` semantics — survives server restart so
   * `/queue` Send-draft UI doesn't lose its spinner on `bun --watch` reloads.
   * Cleared on success via `setQueueStatus('sent', …)`, on failure via
   * `clearQueueSendingMarker`, on cold boot via `sweepStaleQueueSends`.
   */
  claimQueueSendingMarker(input: {
    id: number;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.claimMarker({
      table: "target_queue",
      pkeyWhere: "id = ?",
      column: "send_started_at",
      pkeyValues: [input.id],
      startedAtIso: input.startedAtIso,
      ...(input.staleCutoffIso ? { staleCutoffIso: input.staleCutoffIso } : {}),
    });
  }

  clearQueueSendingMarker(id: number): void {
    this.clearMarker({
      table: "target_queue",
      pkeyWhere: "id = ?",
      column: "send_started_at",
      pkeyValues: [id],
    });
  }

  /**
   * Sweep queue rows whose `send_started_at` is older than `maxAgeMs` (or any
   * non-null when 0 — cold-boot semantics). For each: classify by current
   * status. status='sent' means the SDK call landed before the kill (clear
   * the marker only); otherwise the send was stranded (clear the marker,
   * draft is still on the row for retry).
   */
  sweepStaleQueueSends(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(
        `SELECT id, status, send_started_at FROM target_queue WHERE send_started_at IS NOT NULL`,
      )
      .all() as Array<{ id: number; status: string; send_started_at: string }>;
    const swept: Array<{
      id: number;
      startedAt: string;
      ageMs: number;
      actuallySent: boolean;
    }> = [];
    const clear = this.db.prepare(`UPDATE target_queue SET send_started_at = NULL WHERE id = ?`);
    for (const row of rows) {
      const startedMs = new Date(row.send_started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue;
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      clear.run(row.id);
      swept.push({
        id: row.id,
        startedAt: row.send_started_at,
        ageMs,
        actuallySent: row.status === "sent",
      });
    }
    return swept;
  }

  approveAllPending(opts: { playName?: string } = {}): number {
    const where: string[] = ["status = 'pending'"];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'approved', reviewed_at = ? WHERE ${where.join(" AND ")}`,
      )
      .run(...([new Date().toISOString(), ...args] as never[]));
    return Number(result.changes);
  }

  /**
   * Atomic claim-and-return. SELECTs approved rows whose lease has expired
   * (or was never set) and UPDATEs their `drain_claimed_at` inside a single
   * transaction so two concurrent drains can't return overlapping row sets.
   * Default lease: 15 min — a crashed drain's claims self-heal after that
   * without any sweeper. Held/error rows naturally back off for the lease
   * duration (no LLM-burn loops on stuck-flagged content).
   */
  dequeueApproved(opts: { playName: string; limit?: number; leaseSeconds?: number }): QueueRow[] {
    const leaseSeconds = opts.leaseSeconds ?? 900;
    const claimedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - leaseSeconds * 1000).toISOString();
    const limit = opts.limit ?? 50;
    const txn = this.db.transaction((): QueueRow[] => {
      const rows = this.db
        .query(
          `SELECT * FROM target_queue
           WHERE play_name = ? AND status = 'approved'
             AND (drain_claimed_at IS NULL OR drain_claimed_at < ?)
           ORDER BY found_at ASC
           LIMIT ?`,
        )
        .all(opts.playName, cutoff, limit) as QueueRow[];
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE target_queue SET drain_claimed_at = ? WHERE id IN (${placeholders})`)
        .run(...([claimedAt, ...ids] as never[]));
      return rows;
    });
    // BEGIN IMMEDIATE takes a RESERVED lock at the start of the transaction
    // instead of the default DEFERRED (which only locks on the first write).
    // In WAL mode with two processes, DEFERRED lets both transactions pass
    // the SELECT before either holds the write lock, then the second UPDATE
    // silently overwrites the first's claim — both drains would consider the
    // rows theirs. IMMEDIATE serializes the whole thing across connections.
    return txn.immediate();
  }

  expirePendingOlderThan(days: number): number {
    const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'expired' WHERE status = 'pending' AND found_at < ?`,
      )
      .run(sinceIso);
    return Number(result.changes);
  }

  queueCounts(): Record<QueueStatus, number> {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS n FROM target_queue GROUP BY status")
      .all() as Array<{ status: QueueStatus; n: number }>;
    const out: Record<QueueStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      sent: 0,
      expired: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // ── runs (per-/run-page dispatch records) ──────────────────────────────────
  //
  // Each click of the /run page's Execute CTA creates one `runs` row. The SSE
  // endpoint persists every draft / send / error event to the row's
  // `events_json` and updates counters atomically. The UI reads this row to
  // rebuild progress on nav-back, and inspects `status` to decide whether to
  // poll (running) or stop (done / interrupted). Cold-boot sweep flips any
  // stranded `running` rows to `interrupted` so the founder sees the truth
  // instead of an eternal spinner.

  createRun(input: { playName: string; dryRun: boolean; targets: unknown[] }): {
    runId: number;
    startedAt: string;
  } {
    const startedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO runs(play_name, dry_run, status, started_at, target_count, targets_json)
         VALUES(?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        input.playName,
        input.dryRun ? 1 : 0,
        startedAt,
        input.targets.length,
        JSON.stringify(input.targets),
      );
    return { runId: Number(result.lastInsertRowid), startedAt };
  }

  /**
   * Append a single event to a run's events_json and bump the matching
   * counter. Cheap re-serialize is fine — events_json fits in a single row;
   * runs are bounded at ~25 targets typically.
   */
  appendRunEvent(input: { runId: number; event: unknown }): void {
    const row = this.db
      .query(
        `SELECT events_json, drafted_count, sent_count, error_count
         FROM runs WHERE id = ?`,
      )
      .get(input.runId) as {
      events_json: string;
      drafted_count: number;
      sent_count: number;
      error_count: number;
    } | null;
    if (!row) return;
    let events: unknown[];
    try {
      events = JSON.parse(row.events_json) as unknown[];
      if (!Array.isArray(events)) events = [];
    } catch {
      events = [];
    }
    events.push(input.event);
    // Counter bump driven by event.kind — keeps the writer side simple and
    // the read side stable. Unknown kinds are appended without counter change.
    const kind =
      input.event && typeof input.event === "object"
        ? ((input.event as { kind?: string }).kind ?? null)
        : null;
    let drafted = row.drafted_count;
    let sent = row.sent_count;
    let errors = row.error_count;
    if (kind === "draft") drafted++;
    else if (kind === "send") sent++;
    else if (kind === "error") errors++;
    this.db
      .prepare(
        `UPDATE runs
         SET events_json = ?, drafted_count = ?, sent_count = ?, error_count = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(events), drafted, sent, errors, input.runId);
  }

  markRunComplete(input: {
    runId: number;
    status: "done" | "interrupted";
    sentEmails?: string[];
  }): void {
    const completedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, completed_at = ?, prospect_emails_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(input.status, completedAt, JSON.stringify(input.sentEmails ?? []), input.runId);
  }

  getRun(runId: number): {
    id: number;
    playName: string;
    dryRun: boolean;
    status: "running" | "done" | "interrupted";
    startedAt: string;
    completedAt: string | null;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
    targets: unknown[];
    events: unknown[];
    prospectEmails: string[];
  } | null {
    const row = this.db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as {
      id: number;
      play_name: string;
      dry_run: number;
      status: "running" | "done" | "interrupted";
      started_at: string;
      completed_at: string | null;
      target_count: number;
      drafted_count: number;
      sent_count: number;
      error_count: number;
      targets_json: string;
      events_json: string;
      prospect_emails_json: string;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      playName: row.play_name,
      dryRun: row.dry_run === 1,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      targetCount: row.target_count,
      draftedCount: row.drafted_count,
      sentCount: row.sent_count,
      errorCount: row.error_count,
      targets: safeParseJsonArray(row.targets_json),
      events: safeParseJsonArray(row.events_json),
      prospectEmails: safeParseJsonArray(row.prospect_emails_json) as string[],
    };
  }

  /**
   * Compact run listing for dashboards. Returns lightweight columns only —
   * `events_json` + `targets_json` stay on the row but aren't read here so
   * `/api/home` doesn't pay to ship them on every 30s poll. Default order:
   * newest started_at first; capped at `limit` rows (default 5). When
   * `status` is set, filters via the existing `idx_runs_status` index.
   */
  listRuns(opts: { status?: "running" | "done" | "interrupted"; limit?: number } = {}): Array<{
    id: number;
    playName: string;
    status: "running" | "done" | "interrupted";
    startedAt: string;
    completedAt: string | null;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
  }> {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 5));
    const where = opts.status ? "WHERE status = ?" : "";
    const args = opts.status ? [opts.status, limit] : [limit];
    const rows = this.db
      .query(
        `SELECT id, play_name, status, started_at, completed_at,
                target_count, drafted_count, sent_count, error_count
         FROM runs
         ${where}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...(args as never[])) as Array<{
      id: number;
      play_name: string;
      status: "running" | "done" | "interrupted";
      started_at: string;
      completed_at: string | null;
      target_count: number;
      drafted_count: number;
      sent_count: number;
      error_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      playName: r.play_name,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      targetCount: r.target_count,
      draftedCount: r.drafted_count,
      sentCount: r.sent_count,
      errorCount: r.error_count,
    }));
  }

  /**
   * Sweep run rows whose status is still 'running' but predate the cutoff
   * (or any non-null when 0 — cold-boot semantics). Marks them as
   * 'interrupted' so the UI shows a truthful banner instead of an eternal
   * spinner. Returns the swept rows so the caller can log them.
   */
  sweepStaleRuns(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    playName: string;
    startedAt: string;
    ageMs: number;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(`SELECT id, play_name, started_at FROM runs WHERE status = 'running'`)
      .all() as Array<{ id: number; play_name: string; started_at: string }>;
    const swept: Array<{
      id: number;
      playName: string;
      startedAt: string;
      ageMs: number;
    }> = [];
    const update = this.db.prepare(
      `UPDATE runs SET status = 'interrupted', completed_at = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue;
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      update.run(input.now.toISOString(), row.id);
      swept.push({
        id: row.id,
        playName: row.play_name,
        startedAt: row.started_at,
        ageMs,
      });
    }
    return swept;
  }

  // ── triggers (find watch state) ────────────────────────────────────────────

  upsertTrigger(input: { name: string; configJson: string; enabled?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO triggers(name, enabled, config_json)
         VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json`,
      )
      .run(input.name, input.enabled === false ? 0 : 1, input.configJson);
  }

  getTrigger(name: string): TriggerRow | null {
    return (this.db.query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRow) ?? null;
  }

  listTriggers(): TriggerRow[] {
    return this.db.query("SELECT * FROM triggers ORDER BY name ASC").all() as TriggerRow[];
  }

  /**
   * Records the result of a finished run AND clears `running_started_at` in
   * the same statement. This is the only "completed" path — both success and
   * caught-finder-throw funnel through here, so clearing the in-flight flag
   * here is the right semantic.
   */
  updateTriggerLastPoll(input: { name: string; summary: unknown }): void {
    this.db
      .prepare(
        `UPDATE triggers
         SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
         WHERE name = ?`,
      )
      .run(new Date().toISOString(), JSON.stringify(input.summary), input.name);
  }

  /**
   * Atomic claim: marks a trigger as in-flight ONLY if it's not already
   * running. Returns true when the claim succeeded (caller may proceed to
   * fire), false when another caller already holds the slot.
   *
   * The conditional UPDATE closes the TOCTOU race that would otherwise let
   * two concurrent `fireTriggerNow` calls both pass an `isTriggerRunning()`
   * check, both write, both fire — burning real $ on duplicate API spend.
   * SQLite serializes writes per process, so the second UPDATE's `changes`
   * count is 0.
   *
   * `staleCutoffIso` (optional): when provided, the claim ALSO succeeds if
   * the existing `running_started_at` is older than the cutoff — a stale
   * marker (process killed, never cleared, freshness gate already says "not
   * running"). Without this, a 4h-stale row would 409 every retry until
   * the next cold-boot sweep, leaving the founder stuck.
   *
   * Cleared by `updateTriggerLastPoll` on completion or by
   * `sweepStaleRunningTriggers` on the next cold boot.
   */
  markTriggerRunning(name: string, startedAtIso: string, staleCutoffIso?: string): boolean {
    return this.claimMarker({
      table: "triggers",
      pkeyWhere: "name = ?",
      column: "running_started_at",
      pkeyValues: [name],
      startedAtIso,
      ...(staleCutoffIso ? { staleCutoffIso } : {}),
    });
  }

  /**
   * Sweep trigger rows whose `running_started_at` is older than `maxAgeMs`.
   * For each match, write a `last_run_summary = { error: "killed_by_restart",
   * at }` and clear the in-flight flag. Returns the swept rows so the caller
   * can log them.
   *
   * Pure-ish (takes `now` + `maxAgeMs` as args) so tests can drive both
   * "fresh entries are spared" and "stale entries are swept" without
   * faking the system clock.
   */
  sweepStaleRunningTriggers(input: {
    now: Date;
    maxAgeMs: number;
  }): Array<{ name: string; startedAt: string; ageMs: number }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(`SELECT name, running_started_at FROM triggers WHERE running_started_at IS NOT NULL`)
      .all() as Array<{ name: string; running_started_at: string }>;
    const swept: Array<{ name: string; startedAt: string; ageMs: number }> = [];
    const update = this.db.prepare(
      `UPDATE triggers
       SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
       WHERE name = ?`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.running_started_at).getTime();
      if (!Number.isFinite(startedMs)) {
        // Garbage timestamp — clear it so it doesn't perpetually re-trip.
        update.run(
          input.now.toISOString(),
          JSON.stringify({
            error: "killed_by_restart",
            reason: "running_started_at unparseable",
            at: input.now.toISOString(),
          }),
          row.name,
        );
        continue;
      }
      if (startedMs > cutoffMs) continue; // still fresh
      const ageMs = input.now.getTime() - startedMs;
      update.run(
        input.now.toISOString(),
        JSON.stringify({
          error: "killed_by_restart",
          startedAt: row.running_started_at,
          ageMs,
          at: input.now.toISOString(),
        }),
        row.name,
      );
      swept.push({ name: row.name, startedAt: row.running_started_at, ageMs });
    }
    return swept;
  }

  setTriggerEnabled(name: string, enabled: boolean): void {
    this.db.prepare(`UPDATE triggers SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name);
  }

  setTriggerConfig(name: string, configJson: string): void {
    this.db.prepare(`UPDATE triggers SET config_json = ? WHERE name = ?`).run(configJson, name);
  }

  /**
   * Associate a queued target with a known prospect (so the queue page can
   * link back to the prospect record). Best-effort — the caller is expected
   * to swallow failures since the link is a convenience, not a correctness
   * invariant.
   */
  setQueueProspectId(id: number, prospectId: number): void {
    this.db.prepare(`UPDATE target_queue SET prospect_id = ? WHERE id = ?`).run(prospectId, id);
  }

  /**
   * Persist the most-recent draft generated for this queue row. Called by
   * the SSE /run endpoint after the play returns drafted output, so the
   * founder can review subject/body/flags on /queue at any later time
   * (the /run page itself is ephemeral).
   *
   * Most-recent-wins — re-runs overwrite without history. `last_drafted_at`
   * is stored as ISO so it sorts/compares cleanly with the rest of the
   * timestamp columns; the JSON envelope also embeds `draftedAt` for
   * callers that already have the row payload.
   */
  setQueueDraft(input: {
    id: number;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      sent: boolean;
      receiptIds: number[];
      dryRun: boolean;
      enrichmentFailed?: boolean;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ? WHERE id = ?`)
      .run(json, draftedAtIso, input.id);
  }

  close(): void {
    this.db.close();
  }
}

let singleton: Ledger | null = null;

export function getLedger(): Ledger {
  if (!singleton) singleton = new Ledger();
  return singleton;
}
