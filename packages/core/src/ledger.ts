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
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedupe ON target_queue(play_name, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON target_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_play ON target_queue(play_name);

      CREATE TABLE IF NOT EXISTS triggers (
        name TEXT PRIMARY KEY,
        last_polled_at TEXT,
        last_run_summary TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT OR IGNORE INTO schema_version(version) VALUES(4);
    `);

    // Lightweight migrations for installs that pre-date a column.
    this.addColumnIfMissing("prospects", "phone", "TEXT");
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

  listAllCadences(): Array<{
    prospect_id: number;
    play_name: string;
    current_step: number;
    status: string;
    enrolled_at: string;
    next_due_at: string | null;
    last_polled_at: string | null;
    prospect_email: string | null;
    prospect_name: string | null;
    prospect_company: string | null;
  }> {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all() as never;
  }

  advanceCadence(input: {
    prospectId: number;
    playName: string;
    newStep: number;
    nextDueAt: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET current_step = ?, next_due_at = ?, last_polled_at = datetime('now')
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.newStep, input.nextDueAt, input.prospectId, input.playName);
  }

  setCadenceStatus(input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed";
  }): void {
    this.db
      .prepare(`UPDATE cadence_state SET status = ? WHERE prospect_id = ? AND play_name = ?`)
      .run(input.status, input.prospectId, input.playName);
  }

  findProspectByEmail(email: string): { id: number } | null {
    return (
      (this.db.query("SELECT id FROM prospects WHERE email = ?").get(email) as { id: number }) ??
      null
    );
  }

  recordReceipt(input: {
    playName: string;
    callType: string;
    costUsd?: number;
    signedReceipt?: unknown;
    oneshotRequestId?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt, oneshot_request_id)
      VALUES(?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.playName,
      input.callType,
      input.costUsd ?? null,
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
    if (input.email) {
      const existing = this.db.query("SELECT id FROM prospects WHERE email = ?").get(input.email) as
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
      input.email ?? null,
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
    last_event_at: string | null;
  }> {
    const sql = `
      SELECT p.id, p.name, p.email, p.company, MAX(s.created_at) AS last_event_at
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
  }): number | null {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, notes)
           VALUES(?, ?, ?, ?, ?)`,
        )
        .run(
          input.playName,
          JSON.stringify(input.payload),
          input.dedupeKey,
          input.source,
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

  dequeueApproved(opts: { playName: string; limit?: number }): QueueRow[] {
    const sql = `
      SELECT * FROM target_queue
      WHERE play_name = ? AND status = 'approved'
      ORDER BY found_at ASC
      LIMIT ?
    `;
    return this.db.query(sql).all(opts.playName, opts.limit ?? 50) as QueueRow[];
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

  updateTriggerLastPoll(input: { name: string; summary: unknown }): void {
    this.db
      .prepare(`UPDATE triggers SET last_polled_at = ?, last_run_summary = ? WHERE name = ?`)
      .run(new Date().toISOString(), JSON.stringify(input.summary), input.name);
  }

  setTriggerEnabled(name: string, enabled: boolean): void {
    this.db.prepare(`UPDATE triggers SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name);
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
