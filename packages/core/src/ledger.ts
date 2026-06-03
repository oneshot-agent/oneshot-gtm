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

/**
 * Canonical form for matching prospect emails — trim + lowercase. Inbound reply
 * addresses (cadence inbox poll) are normalized the same way, so a prospect
 * stored from a mixed-case address still matches when they reply. Applied on
 * both store (upsertProspect) and every lookup so the two never diverge.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
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
           last_polled_at = NULL`,
      )
      .run(input.prospectId, input.playName, input.nextDueAt);
  }

  listActiveCadences(opts: { dueByIso?: string } = {}): Array<{
    prospect_id: number;
    play_name: string;
    current_step: number;
    status: string;
    enrolled_at: string;
    next_due_at: string | null;
    last_polled_at: string | null;
    next_step_draft_json: string | null;
    next_step_drafted_at: string | null;
    prospect_email: string | null;
    prospect_name: string | null;
    prospect_company: string | null;
  }> {
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
    // Also clear any persisted next-step draft — it was for the OLD next
    // step; advancing makes it stale and unsafe to send against the new
    // step. /cadences will surface a fresh "no preview yet" state.
    this.db
      .prepare(
        `UPDATE cadence_state
         SET current_step = ?, next_due_at = ?, last_polled_at = datetime('now'),
             next_step_draft_json = NULL, next_step_drafted_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.newStep, input.nextDueAt, input.prospectId, input.playName);
  }

  setCadenceStatus(input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed";
  }): void {
    // Non-active terminal states clear the persisted draft too — a replied /
    // breakup / completed cadence shouldn't have a sendable preview hanging
    // around (the founder might click Send by accident, but the send route
    // also re-checks status='active', so this is defense in depth).
    this.db
      .prepare(
        `UPDATE cadence_state
         SET status = ?,
             next_step_draft_json = CASE WHEN ? = 'active' THEN next_step_draft_json ELSE NULL END,
             next_step_drafted_at = CASE WHEN ? = 'active' THEN next_step_drafted_at ELSE NULL END
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.status, input.status, input.status, input.prospectId, input.playName);
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

  /** Cached enrichProfile result for an email (profiles are stable; reused with a TTL). */
  getCachedEnrichment(email: string): { result_json: string; fetched_at: string } | null {
    return (
      (this.db
        .query("SELECT result_json, fetched_at FROM enrichment_cache WHERE email = ?")
        .get(email) as { result_json: string; fetched_at: string }) ?? null
    );
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    this.db
      .prepare(
        `INSERT INTO enrichment_cache(email, result_json, fetched_at)
         VALUES(?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET result_json = excluded.result_json, fetched_at = excluded.fetched_at`,
      )
      .run(email, resultJson, new Date().toISOString());
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
  }): number {
    // Number.isFinite guard rejects undefined / Infinity / NaN — those land
    // as NULL in the column, NOT silently distorted into a number.
    const costUsd =
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null;
    const stmt = this.db.prepare(`
      INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt, oneshot_request_id)
      VALUES(?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.playName,
      input.callType,
      costUsd,
      input.signedReceipt ? JSON.stringify(input.signedReceipt) : null,
      input.oneshotRequestId ?? null,
    );
    return Number(result.lastInsertRowid);
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
    if (input.status === "sent") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, sent_at = ?, reviewed_at = COALESCE(reviewed_at, ?) ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, now, input.notes, input.id]
            : [input.status, now, now, input.id]),
        );
    } else if (input.status === "approved" || input.status === "rejected") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, reviewed_at = ? ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, input.notes, input.id]
            : [input.status, now, input.id]),
        );
    } else {
      this.db
        .prepare(`UPDATE target_queue SET status = ? WHERE id = ?`)
        .run(input.status, input.id);
    }
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
    if (staleCutoffIso) {
      const result = this.db
        .prepare(
          `UPDATE triggers
           SET running_started_at = ?
           WHERE name = ? AND (running_started_at IS NULL OR running_started_at < ?)`,
        )
        .run(startedAtIso, name, staleCutoffIso);
      return result.changes > 0;
    }
    const result = this.db
      .prepare(
        `UPDATE triggers
         SET running_started_at = ?
         WHERE name = ? AND running_started_at IS NULL`,
      )
      .run(startedAtIso, name);
    return result.changes > 0;
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
