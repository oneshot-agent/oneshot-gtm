import type { Database } from "bun:sqlite";
import type { ReceiptRecord } from "./types.ts";
import { toSqliteUtc } from "./time.ts";

/**
 * Call types whose stored result is read back, so it is kept whole:
 * email.find/verify results back the 14-day contact reuse
 * (`findContactReceipt`, find's `_sdk-safe.ts`), and direct_mail.order holds
 * the platform's own signed receipt.
 */
export const VERBATIM_RECEIPT_CALL_TYPES: ReadonlySet<string> = new Set([
  "email.find",
  "email.verify",
  "direct_mail.order",
]);

/** Strings longer than this are replaced by a length marker. */
export const RECEIPT_STRING_CAP = 1000;
/** Arrays keep this many items, then a count of the rest. */
export const RECEIPT_ARRAY_CAP = 100;

const OMITTED_ITEMS = /^\[omitted: \d+ more items\]$/;

function slimValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > RECEIPT_STRING_CAP ? `[omitted: ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    // Already capped by an earlier pass: keep its marker (and the original
    // count in it) instead of treating the marker as the 101st item.
    const last = value.at(-1);
    if (
      value.length === RECEIPT_ARRAY_CAP + 1 &&
      typeof last === "string" &&
      OMITTED_ITEMS.test(last)
    ) {
      return [...value.slice(0, RECEIPT_ARRAY_CAP).map(slimValue), last];
    }
    const kept = value.slice(0, RECEIPT_ARRAY_CAP).map(slimValue);
    if (value.length > RECEIPT_ARRAY_CAP) {
      kept.push(`[omitted: ${value.length - RECEIPT_ARRAY_CAP} more items]`);
    }
    return kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, slimValue(v)]));
  }
  return value;
}

/**
 * What `signed_receipt` keeps for one call: the receipt envelope (receipt_id,
 * request_id, cost, settlement_status) and the call's short identifiers
 * (message_id, thread_id, url, subject, ...), not the tool's payload. A web.read
 * result carried the whole page, which made receipts most of the ledger's size
 * while nothing read it back. The column holds no signature: the signed
 * receipt lives on the platform and signs metadata, not the payload.
 */
export function slimReceiptPayload(callType: string, payload: unknown): unknown {
  return VERBATIM_RECEIPT_CALL_TYPES.has(callType) ? payload : slimValue(payload);
}

/** Rows smaller than this (in bytes) are left alone by `compactPayloads`. */
const COMPACT_MIN_BYTES = 4096;
const COMPACT_BATCH = 500;

export interface ReceiptCompaction {
  rows: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Rows whose JSON didn't parse; left untouched. */
  skipped: number;
}

/**
 * Receipt persistence for the ledger's `receipts` table: writes
 * (`recordReceipt`), reads (`getReceipt`/`listReceipts`), attribution
 * (`setReceiptValueTag`/`setReceiptValueTagByGoal`/`currentGoalValueTag`/
 * `goalLabels`), and aggregation (`spendByPlay`/`countReceipts`/
 * `spendSeriesByPlay`/`totalSpendUsd`/`listValueTaggedReceipts`). Extracted
 * from `Ledger` (see ledger.ts) as the next slice of the split tracked in
 * ROADMAP.md, following the schema extraction in #452.
 *
 * Pure wrapper around a raw `Database` handle — same shape as
 * `migrateLedgerSchema` in ledger-schema.ts — so it can be constructed and
 * exercised without the rest of Ledger's surface. `Ledger` owns exactly one
 * instance (constructed after `migrate()` runs) and delegates every receipt
 * method to it, preserving each method's existing signature, return value,
 * transaction boundary, and caller.
 */
export class ReceiptStore {
  constructor(private readonly db: Database) {}

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
    /** Call-time memo (the same value sent to OneShot); defaults to "{play} {callType}". */
    memo?: string;
    /** Call-time decisionContext blob; JSON-stringified into the column. */
    decisionContext?: unknown;
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
    // Mirror what buildAuditOpts sends to OneShot so the stored memo/context
    // match the platform receipt even at call sites that don't enrich.
    const memo = input.memo ?? `${input.playName} ${input.callType}`;
    const decisionContext = input.decisionContext ?? {
      playName: input.playName,
      callType: input.callType,
    };
    // Mirror the cadence correlation key (decisionContext.goalId) into its own
    // column so an outcome can value-tag the whole goal in one UPDATE.
    const goalId =
      typeof (decisionContext as { goalId?: unknown }).goalId === "string"
        ? (decisionContext as { goalId: string }).goalId
        : null;
    const stmt = this.db.prepare(`
      INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, sender_identity, memo, decision_context, goal_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.playName,
      input.callType,
      costUsd,
      input.signedReceipt
        ? JSON.stringify(slimReceiptPayload(input.callType, input.signedReceipt))
        : null,
      input.oneshotRequestId ?? null,
      input.senderIdentity ?? null,
      memo,
      JSON.stringify(decisionContext),
      goalId,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Trim receipts written before `slimReceiptPayload` existed. Dry run unless
   * `apply`. Writes go in short IMMEDIATE batches so a running server keeps
   * working between them. Idempotent: a row slimming wouldn't change is
   * neither counted nor rewritten.
   */
  compactPayloads(opts: { apply: boolean }): ReceiptCompaction {
    const verbatim = [...VERBATIM_RECEIPT_CALL_TYPES];
    // Paged by id so memory stays one page, whatever the ledger's size; this
    // also runs inside doctor on the dashboard server. CAST AS BLOB makes
    // length() count bytes, not characters.
    const page = this.db.query(
      `SELECT id, call_type, signed_receipt FROM receipts
       WHERE id > ? AND length(CAST(signed_receipt AS BLOB)) > ?
         AND call_type NOT IN (${verbatim.map(() => "?").join(",")})
       ORDER BY id LIMIT ?`,
    );
    const update = this.db.prepare("UPDATE receipts SET signed_receipt = ? WHERE id = ?");
    const out: ReceiptCompaction = { rows: 0, bytesBefore: 0, bytesAfter: 0, skipped: 0 };
    let afterId = 0;
    for (;;) {
      const rows = page.all(afterId, COMPACT_MIN_BYTES, ...verbatim, COMPACT_BATCH) as Array<{
        id: number;
        call_type: string;
        signed_receipt: string;
      }>;
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1]!.id;
      const updates: Array<[string, number]> = [];
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.signed_receipt);
        } catch {
          out.skipped++;
          continue;
        }
        const slim = JSON.stringify(slimReceiptPayload(row.call_type, parsed));
        // Already within the caps (e.g. many short fields): nothing to trim.
        if (slim === JSON.stringify(parsed)) continue;
        out.rows++;
        out.bytesBefore += Buffer.byteLength(row.signed_receipt);
        out.bytesAfter += Buffer.byteLength(slim);
        updates.push([slim, row.id]);
      }
      if (opts.apply && updates.length > 0) {
        this.db
          .transaction(() => {
            for (const [json, id] of updates) update.run(json, id);
          })
          .immediate();
      }
    }
    return out;
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
      args.push(toSqliteUtc(opts.sinceIso));
    }
    const sql = `SELECT * FROM receipts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return this.db.query(sql).all(...(args as never[])) as ReceiptRecord[];
  }

  /** Reuse only completed contact results with an exact identity, within 14 days. */
  findContactReceipt(
    input: { email: string } | { fullName: string; companyDomain: string },
  ): ReceiptRecord | null {
    const verify = "email" in input;
    const fields = verify ? ["email"] : ["full_name", "company_domain"];
    const values = verify ? [input.email] : [input.fullName, input.companyDomain];
    if (values.some((value) => !value.trim())) return null;
    const match = fields
      .map((field) => `lower(trim(json_extract(signed_receipt, '$.${field}'))) = ?`)
      .join(" AND ");
    return this.db
      .query(`
      SELECT * FROM receipts
      WHERE call_type = ? AND created_at >= datetime('now', '-14 days')
        AND CASE WHEN json_valid(signed_receipt) THEN
          json_extract(signed_receipt, '$.status') = 'completed' AND ${match}
        ELSE 0 END
      ORDER BY created_at DESC, id DESC LIMIT 1
    `)
      .get(
        verify ? "email.verify" : "email.find",
        ...values.map((value) => value.trim().toLowerCase()),
      ) as ReceiptRecord | null;
  }

  /** Persist the RoCS value tag (JSON `{type,amount?,label?}`) on a single receipt. */
  setReceiptValueTag(receiptId: number, valueTagJson: string): void {
    this.db
      .prepare(`UPDATE receipts SET value_tag = ?, value_tagged_at = datetime('now') WHERE id = ?`)
      .run(valueTagJson, receiptId);
  }

  /**
   * Local mirror of a goal-level value tag: stamp every receipt in the cadence
   * (matching `goal_id`) so the /receipts UI shows the value per row. Returns the
   * number of receipts touched. The platform records the value once per goal via
   * `tagReceiptValue({goalId})`; this just keeps the dashboard in sync.
   */
  setReceiptValueTagByGoal(goalId: string, valueTagJson: string): number {
    const res = this.db
      .prepare(
        `UPDATE receipts SET value_tag = ?, value_tagged_at = datetime('now') WHERE goal_id = ?`,
      )
      .run(valueTagJson, goalId);
    return res.changes;
  }

  /** Current local value tag for a goal (any one of its receipts), or null. */
  currentGoalValueTag(goalId: string): string | null {
    const row = this.db
      .query(`SELECT value_tag FROM receipts WHERE goal_id = ? AND value_tag IS NOT NULL LIMIT 1`)
      .get(goalId) as { value_tag: string } | undefined;
    return row?.value_tag ?? null;
  }

  /**
   * Human labels (play + prospect) for a set of goalIds, derived from the local
   * receipts so the Measure page can render OneShot's opaque goal_id rollups as
   * "{play} → {prospect}". First receipt per goal wins.
   */
  goalLabels(goalIds: string[]): Map<string, { playName: string | null; prospect: string | null }> {
    const out = new Map<string, { playName: string | null; prospect: string | null }>();
    if (goalIds.length === 0) return out;
    const placeholders = goalIds.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT goal_id, play_name, decision_context FROM receipts WHERE goal_id IN (${placeholders})`,
      )
      .all(...goalIds) as Array<{
      goal_id: string;
      play_name: string;
      decision_context: string | null;
    }>;
    for (const r of rows) {
      if (out.has(r.goal_id)) continue;
      let prospect: string | null = null;
      if (r.decision_context) {
        try {
          const dc = JSON.parse(r.decision_context) as {
            prospectEmail?: string;
            customerName?: string;
          };
          prospect = dc.prospectEmail ?? dc.customerName ?? null;
        } catch {
          prospect = null;
        }
      }
      out.set(r.goal_id, { playName: r.play_name, prospect });
    }
    return out;
  }

  spendByPlay(
    opts: { sinceIso?: string } = {},
  ): Array<{ play_name: string; calls: number; total_usd: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(toSqliteUtc(opts.sinceIso));
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

  /**
   * How many receipts fall in the window.
   *
   * Callers wanting a count must not list the rows and measure the array: the
   * Today page did exactly that behind a `limit: 1000`, so any install busy
   * enough to exceed it reported precisely 1000 calls a week, for ever, with
   * nothing in the response to say it had been truncated.
   */
  countReceipts(opts: { sinceIso?: string; playName?: string } = {}): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(toSqliteUtc(opts.sinceIso));
    }
    const sql = `SELECT COUNT(*) AS n FROM receipts${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  /**
   * Daily signed spend per play, for the trend sparklines on Measure.
   *
   * Bucketed in SQL rather than by listing receipts and grouping in the
   * browser. The page used to pull 500 rows and bucket them client-side, which
   * silently became a five-hour window once an install carried tens of
   * thousands of receipts; and `new Date("YYYY-MM-DD HH:MM:SS")` parses as
   * local time, so the buckets drifted by the viewer's UTC offset. `date()`
   * here has neither problem.
   */
  spendSeriesByPlay(opts: { days: number }): Array<{
    play_name: string;
    day: string;
    total_usd: number;
  }> {
    const sql = `
      SELECT play_name, date(created_at) AS day, COALESCE(SUM(cost_usd), 0) AS total_usd
      FROM receipts
      WHERE cost_usd IS NOT NULL AND date(created_at) >= date('now', ?)
      GROUP BY play_name, day
      ORDER BY day ASC
    `;
    return this.db.query(sql).all(`-${Math.max(1, Math.floor(opts.days))} days` as never) as never;
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
      args.push(toSqliteUtc(opts.sinceIso));
    }
    const sql = `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM receipts WHERE ${where.join(" AND ")}`;
    return (this.db.query(sql).get(...(args as never[])) as { total: number } | null)?.total ?? 0;
  }

  /**
   * The local funnel ladder: receipts value-tagged by outcome attribution
   * (engagement < meeting < qualified < revenue). goal_id is a sha256 of
   * (play, email) — not computable in SQLite, so the caller joins in JS via
   * `cadenceGoalId`.
   */
  listValueTaggedReceipts(): Array<{ goal_id: string; value_tag: string }> {
    return this.db
      .query(
        `SELECT goal_id, value_tag FROM receipts
         WHERE value_tag IS NOT NULL AND goal_id IS NOT NULL`,
      )
      .all() as Array<{ goal_id: string; value_tag: string }>;
  }
}
