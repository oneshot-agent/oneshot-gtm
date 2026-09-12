import type { Database } from "bun:sqlite";
import { extractBusinessAddress } from "./mail-address.ts";
import { humanDecisionWhereSql } from "./labels.ts";
import type {
  IcpDecisionExample,
  ProspectPriority,
  QueueRow,
  QueueSearchOpts,
  QueueSearchRow,
  QueueStatus,
  SentOutcomeRawRow,
} from "./types.ts";

/**
 * Queue (`target_queue`) persistence — the queue slice of the ledger split
 * tracked in ROADMAP.md (issue #631, follow-up to the bounce/canary/receipt
 * extractions in #617/#616). Queue reads, writes, state transitions,
 * selection/drain operations and queue-only transactions live here.
 *
 * Pure wrapper around a raw `Database` handle, mirroring `ledger-receipts.ts`'s
 * `ReceiptStore` and `delivery-health.ts`'s functions: no dependency on the
 * `Ledger` class, so this domain can be constructed and tested in isolation.
 * `Ledger` owns exactly one instance (constructed after `migrate()` runs, so
 * `target_queue` already exists) and delegates every queue method to it,
 * preserving each method's existing signature, return value, transaction
 * boundary and caller — including the invariant that a sent row can never be
 * re-approved (`setQueueStatus`'s guarded UPDATE + `throwIfSentRowGuardBlocked`,
 * and `claimQueueSendingMarker`'s own `sent_at IS NULL` guard, #561).
 *
 * `setQueueProspectId` is the one method split across the boundary: linking a
 * queue row to a prospect also best-effort seeds a mailing address from the
 * prospect and payload, which reaches into the prospect/mail-address domains
 * that stay on `Ledger` — so only the row's own `prospect_id` UPDATE lives
 * here, and `Ledger.setQueueProspectId` keeps the cross-domain orchestration.
 * Likewise `expireBreakupReviveQueue` is called by `Ledger`'s reply-handling
 * methods (channel_events/cadence_state), but only ever touches
 * `target_queue`, so its implementation lives here with `Ledger` keeping a
 * private one-line delegate at its original call sites.
 */

const QUEUE_STATUSES: readonly QueueStatus[] = [
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
];

/** Escape a user term for `LIKE ? ESCAPE '\'` so `%` and `_` match literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ICP_EXAMPLE_FIELDS = [
  "title",
  "url",
  "summary",
  "author",
  "description",
  "postTitle",
  "postUrl",
  "repo",
  "repoUrl",
  "eventName",
  "eventUrl",
  "company",
] as const;

/** Keep classifier examples useful without returning enriched contact data. */
function icpExampleCandidate(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  return Object.fromEntries(
    ICP_EXAMPLE_FIELDS.flatMap((field) => {
      const value = source[field];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[field, value] as const]
        : [];
    }),
  );
}

/**
 * Canonical form for matching prospect emails — trim + lowercase. Mirrors
 * `Ledger`'s own `canonEmail` (ledger.ts) and `delivery-health.ts`'s copy, so
 * cross-play dedupe stays keyed identically to the rest of the ledger.
 * Duplicated rather than imported/exported across the module boundary for
 * the same reason `delivery-health.ts` duplicates it: a 3-line pure helper,
 * not worth widening either file's public surface for no benefit.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The searchable text of a queue row for `searchQueue`: every identity key a
 * finder writes into `payload_json` (the same keys the /queue row reads —
 * `name`/`founderName`, `email`/`founderEmail`, company, title, the show-hn
 * post, the repo/post URLs a pre-enrichment reject only carries, LinkedIn),
 * plus the reviewer's notes, the play, and the joined prospect record. Built
 * once as a string so each term binds against the same expression.
 *
 * No LOWER(): bun's SQLite has no ICU, so LOWER() and LIKE fold ASCII only.
 * Case-insensitivity for non-ASCII letters comes from binding each term
 * twice (see `likePatternsFor`) rather than from a wrapper that would leave
 * "Émile" unfindable by "émile".
 */
const QUEUE_SEARCH_HAYSTACK = `(${[
  "name",
  "founderName",
  "email",
  "founderEmail",
  "company",
  "title",
  "postTitle",
  "repoUrl",
  "postUrl",
  "linkedinUrl",
]
  .map((key) => `COALESCE(json_extract(b.payload_json, '$.${key}'), '')`)
  .concat([
    "COALESCE(b.notes, '')",
    "b.play_name",
    "COALESCE(p.name, '')",
    "COALESCE(p.email, '')",
    "COALESCE(p.company, '')",
    "COALESCE(p.title, '')",
  ])
  .join(" || ' ' || ")})`;

/**
 * Bind patterns for one search term. LIKE already folds ASCII case, so an
 * ASCII term needs one pattern; a term with non-ASCII letters is bound in
 * lower and upper case, which together also catch title case ("Émile"
 * matches the upper pattern because every ASCII letter after É folds).
 */
function likePatternsFor(term: string): string[] {
  const lower = term.toLowerCase();
  const upper = term.toUpperCase();
  // eslint-disable-next-line no-control-regex
  if (lower === upper || !/[^\x00-\x7f]/.test(term)) return [`%${escapeLike(lower)}%`];
  return [`%${escapeLike(lower)}%`, `%${escapeLike(upper)}%`];
}

/** Best display name for a queue row: the prospect record, then the payload. */
const QUEUE_SEARCH_NAME_EXPR = `COALESCE(NULLIF(p.name, ''), NULLIF(json_extract(b.payload_json, '$.name'), ''), NULLIF(json_extract(b.payload_json, '$.founderName'), ''))`;

export class QueueStore {
  constructor(private readonly db: Database) {}

  /** Recent reviewed rows for few-shot ICP classification. */
  recentIcpDecisions(limit = 20): IcpDecisionExample[] {
    const rows = this.db
      .query(
        `SELECT payload_json, status, notes
         FROM target_queue
         WHERE ${humanDecisionWhereSql()}
           AND play_name IN (
             'show-hn', 'post-funding', 'accelerator-batch', 'job-change',
             'hiring-signal', 'podcast-guest', 'github-topics', 'github-stars',
             'competitor-switch', 'stack-consolidation', 'repo-interest', 'luma-events'
           )
           AND json_valid(payload_json)
         ORDER BY reviewed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      payload_json: string;
      status: "approved" | "rejected" | "sent";
      notes: string | null;
    }>;

    return rows.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        return [
          {
            // Queue payloads grow as a prospect is enriched and can contain
            // email, phone and social-profile fields. Few-shot topic
            // classification only needs the original public source context.
            candidate: icpExampleCandidate(payload),
            decision: row.status !== "rejected",
            reason: row.notes,
          },
        ];
      } catch {
        return [];
      }
    });
  }

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
    /**
     * Shadow-mode priority artifact, persisted verbatim. Omit/null for
     * producers that can't score (manual rows, legacy callers, auto-drops).
     */
    priority?: ProspectPriority | null;
  }): number | null {
    try {
      const status = input.initialStatus ?? "pending";
      const reviewedAt = status === "pending" ? null : new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, reviewed_at, notes, priority_json, decision, decided_at, decided_by)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.playName,
          JSON.stringify(
            input.payload && typeof input.payload === "object"
              ? {
                  ...input.payload,
                  ...(extractBusinessAddress(input.payload)
                    ? { businessAddress: extractBusinessAddress(input.payload) }
                    : {}),
                }
              : input.payload,
          ),
          input.dedupeKey,
          input.source,
          status,
          reviewedAt,
          input.notes ?? null,
          input.priority ? JSON.stringify(input.priority) : null,
          // An insert-time rejection is a gate's verdict, never a human's —
          // structural provenance replaces the `auto:` notes-sniffing (the
          // notes convention stays for humans and pre-v26 fallback).
          status === "rejected" ? "auto_reject" : null,
          status === "rejected" ? reviewedAt : null,
          status === "rejected" ? "machine" : null,
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
   * Cross-play dedup (finder side): is this email in a non-terminal queue row
   * under ANY play? Catches the window before either play has sent (no
   * prospect row exists yet). Matches both `email` and `founderEmail`.
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

  listQueue(
    opts: { playName?: string; status?: QueueStatus; limit?: number; ids?: number[] } = {},
  ): QueueRow[] {
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
    // Explicit row picks (the /queue "drain selected" path). An empty array
    // would compile to `IN ()` — a syntax error in SQLite — and semantically
    // means "nothing selected", so return early rather than silently listing
    // every row.
    if (opts.ids) {
      if (opts.ids.length === 0) return [];
      where.push(`id IN (${opts.ids.map(() => "?").join(",")})`);
      args.push(...opts.ids);
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

  /**
   * Most recent queue row linked to a prospect — the finder's original signal
   * that queued them, used as evidence input to angle synthesis (issue #355).
   * Not every prospect has one: manually added prospects, or rows whose queue
   * entry was never linked via `setQueueProspectId`, return null.
   *
   * Tiebreak on `id DESC` after `found_at DESC`: `found_at` is
   * second-granularity (`datetime('now')`), so two rows queued within the
   * same second — routine in a fast backfill or a test — would otherwise tie
   * and return whichever SQLite happens to prefer.
   */
  getQueueRowForProspect(prospectId: number): QueueRow | null {
    return (
      (this.db
        .query(
          "SELECT * FROM target_queue WHERE prospect_id = ? ORDER BY found_at DESC, id DESC LIMIT 1",
        )
        .get(prospectId) as QueueRow) ?? null
    );
  }

  /**
   * FROM + WHERE shared by `searchQueue` (rows and total) and
   * `searchQueueStatusCounts`. The prospect is resolved with a scalar
   * subquery (`LIMIT 1`) rather than an OR-join so one queue row can never
   * fan out into two — two prospects sharing an email would otherwise
   * inflate `total` and shift every OFFSET. Filters that only need the queue
   * row (status, play, decided_by) go inside the derived table so the
   * existing status/play indexes still prune before the prospect lookup;
   * the free-text terms need the joined prospect and stay outside.
   */
  private queueSearchParts(
    opts: Pick<QueueSearchOpts, "q" | "statuses" | "playName" | "decidedBy">,
    withStatus: boolean,
  ): { sql: string; args: unknown[] } {
    const inner: string[] = [];
    const outer: string[] = [];
    const args: unknown[] = [];
    // De-duplicated: `?status=sent,sent,sent,sent,sent` is one status, not
    // "all five" — the length guard below must see distinct values.
    const statuses = [...new Set((opts.statuses ?? []).filter((s) => QUEUE_STATUSES.includes(s)))];
    if (withStatus && statuses.length > 0 && statuses.length < QUEUE_STATUSES.length) {
      inner.push(`q.status IN (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
    if (opts.playName) {
      inner.push("q.play_name = ?");
      args.push(opts.playName);
    }
    switch (opts.decidedBy) {
      case "human":
        inner.push("q.decided_by IN ('human', 'human_bulk')");
        break;
      case "machine":
        inner.push("q.decided_by = 'machine'");
        break;
      case "none":
        inner.push("q.decided_by IS NULL");
        break;
      default:
        break;
    }
    const terms = (opts.q ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const term of terms) {
      const patterns = likePatternsFor(term);
      outer.push(
        `(${patterns.map(() => `${QUEUE_SEARCH_HAYSTACK} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      args.push(...patterns);
    }
    const sql = `
      FROM (
        SELECT q.*, COALESCE(q.prospect_id, (
            SELECT p2.id FROM prospects p2
             WHERE p2.email = LOWER(TRIM(COALESCE(json_extract(q.payload_json, '$.email'),
                                                  json_extract(q.payload_json, '$.founderEmail'))))
             ORDER BY p2.id LIMIT 1)) AS joined_prospect_id
          FROM target_queue q
          ${inner.length ? `WHERE ${inner.join(" AND ")}` : ""}) b
      LEFT JOIN prospects p ON p.id = b.joined_prospect_id
      ${outer.length ? `WHERE ${outer.join(" AND ")}` : ""}`;
    return { sql, args };
  }

  /**
   * The /prospects browse view: every queue row, any status, searched, sorted
   * and paged. `q` is a deliberate full scan (LIKE over json_extract can use
   * no index) — measured at ~50 ms on 9k rows. Past ~100k rows an FTS5
   * external-content table is the upgrade path; nothing here would change
   * shape. Without `q` the derived table is pruned by the status/play
   * indexes like `listQueue`.
   */
  searchQueue(opts: QueueSearchOpts): { rows: QueueSearchRow[]; total: number | null } {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset));
    const dir = opts.dir === "asc" ? "ASC" : "DESC";
    let orderSql: string;
    switch (opts.sort) {
      case "decided_at":
        // Undecided rows sink to the bottom in both directions.
        orderSql = `(b.decided_at IS NULL) ASC, b.decided_at ${dir}, b.id ${dir}`;
        break;
      case "name":
        // Named rows first; rows that only carry a source URL (pre-enrichment
        // rejects) sort after them by that URL, then by dedupe key.
        orderSql = `(${QUEUE_SEARCH_NAME_EXPR} IS NULL) ASC, LOWER(COALESCE(${QUEUE_SEARCH_NAME_EXPR}, json_extract(b.payload_json, '$.repoUrl'), json_extract(b.payload_json, '$.postUrl'), b.dedupe_key)) ${dir}, b.id ${dir}`;
        break;
      default:
        orderSql = `b.found_at ${dir}, b.id ${dir}`;
        break;
    }
    const { sql, args } = this.queueSearchParts(opts, true);
    const rows = this.db
      .query(
        `SELECT b.*, p.id AS p_id, p.name AS p_name, p.email AS p_email, p.company AS p_company,
                p.title AS p_title,
                p.icp_verdict AS p_icp_verdict, p.icp_verdict_reason AS p_icp_verdict_reason,
                (p.dossier_json IS NOT NULL AND TRIM(p.dossier_json) != '') AS p_has_dossier,
                (b.prospect_id IS NULL AND p.id IS NOT NULL) AS p_linked_by_email
         ${sql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .all(...(args as never[]), limit, offset) as QueueSearchRow[];
    if (opts.withTotal === false) return { rows, total: null };
    const total = (
      this.db.query(`SELECT COUNT(*) AS n ${sql}`).get(...(args as never[])) as {
        n: number;
      }
    ).n;
    return { rows, total };
  }

  /**
   * Per-status counts for the /prospects filter chips under the current
   * search/play/decided filters — the status filter itself is left out so a
   * chip can show how many rows it would reveal.
   */
  searchQueueStatusCounts(
    opts: Pick<QueueSearchOpts, "q" | "playName" | "decidedBy">,
  ): Record<QueueStatus, number> {
    const { sql, args } = this.queueSearchParts(opts, false);
    const rows = this.db
      .query(`SELECT b.status AS status, COUNT(*) AS n ${sql} GROUP BY b.status`)
      .all(...(args as never[])) as Array<{ status: QueueStatus; n: number }>;
    const out: Record<QueueStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      sent: 0,
      expired: 0,
    };
    for (const r of rows) if (r.status in out) out[r.status] = r.n;
    return out;
  }

  /** Every play that has ever enqueued a row, for the /prospects play filter. */
  listQueuePlayNames(): string[] {
    return (
      this.db
        .query("SELECT DISTINCT play_name FROM target_queue ORDER BY play_name ASC")
        .all() as Array<{ play_name: string }>
    ).map((r) => r.play_name);
  }

  /** Remove an unreviewed queue reservation, leaving reviewed rows untouched. */
  removePendingQueueTarget(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM target_queue WHERE id = ? AND status = 'pending'")
      .run(id);
    return result.changes > 0;
  }

  removeExpiredQueueTarget(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM target_queue WHERE id = ? AND status = 'expired'")
      .run(id);
    return result.changes > 0;
  }

  setQueueStatus(input: {
    id: number;
    status: QueueStatus;
    notes?: string;
    /**
     * Who made this transition. Defaults are per-status, chosen so every
     * existing unannotated caller stays correctly classified:
     * - approved → "human": approving IS the review act; no machine path
     *   approves single rows today (bulk goes through approveAllPending).
     * - rejected/sent → "machine": auto-reject gates and drain sends call
     *   this unannotated, and an unannotated caller must never mint a human
     *   REJECTION label (a mislabeled negative poisons any future fit) —
     *   the per-row UI routes pass "human" explicitly.
     */
    decidedBy?: "human" | "machine";
  }): void {
    const now = new Date().toISOString();
    const decidedBy = input.decidedBy ?? (input.status === "approved" ? "human" : "machine");
    // Every status transition clears `send_started_at` — a deliberate status
    // change means the previous "sending" attempt (if any) is settled. Terminal
    // states (sent/rejected/expired) clear naturally. Approved → approved
    // doesn't need to preserve a marker (caller re-claims on the next send).
    if (input.status === "sent") {
      // COALESCE on the decision columns: a drain/run send must never
      // overwrite the human approve that put the row here; a send on a
      // never-decided row records an honest machine disposition.
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, sent_at = ?, reviewed_at = COALESCE(reviewed_at, ?), decision = COALESCE(decision, 'approve'), decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?), send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, now, now, decidedBy, input.notes, input.id]
            : [input.status, now, now, now, decidedBy, input.id]),
        );
    } else if (input.status === "approved" || input.status === "pending") {
      // The ledger, not the routes, owns "never re-approve a sent row": drain
      // picks up every `status = 'approved'` row, so moving a sent row back to
      // pending/approved would re-email the person. queue.ts and
      // add-prospect.ts keep their own pre-checks (they produce the
      // user-facing 400/409 messages), but this is the guard that can't be
      // forgotten by a future caller (#561).
      //
      // The guard is baked into the UPDATE's WHERE clause instead of a
      // separate SELECT-then-UPDATE: a single statement is its own atomic
      // check-and-set, so two processes racing this call in WAL mode can't
      // both pass a "not sent yet" check before either holds the write lock
      // — the same class of race dequeueApproved's BEGIN IMMEDIATE guards
      // against a few lines below (~3449), just closed here by folding the
      // check into one statement instead of wrapping a transaction.
      const decision = input.status === "approved" ? "approve" : null;
      const result =
        input.status === "approved"
          ? this.db
              .prepare(
                `UPDATE target_queue SET status = ?, reviewed_at = ?, decision = ?, decided_at = ?, decided_by = ?, send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ? AND status != 'sent' AND sent_at IS NULL`,
              )
              .run(
                ...(input.notes
                  ? [input.status, now, decision, now, decidedBy, input.notes, input.id]
                  : [input.status, now, decision, now, decidedBy, input.id]),
              )
          : this.db
              .prepare(
                `UPDATE target_queue SET status = ?, reviewed_at = NULL, send_started_at = NULL ${input.notes !== undefined ? ", notes = ?" : ""} WHERE id = ? AND status != 'sent' AND sent_at IS NULL`,
              )
              .run(
                ...(input.notes !== undefined
                  ? [input.status, input.notes, input.id]
                  : [input.status, input.id]),
              );
      this.throwIfSentRowGuardBlocked(result.changes, input.id, input.status);
    } else if (input.status === "rejected") {
      // Always overwrites: the latest decision wins on a re-decide. Rejecting
      // a sent row is allowed — it's a label, not a send, so no sent-row
      // guard here. `notes` follows the pending branch: present (even "")
      // means write it, so a founder can clear a stale reason; absent means
      // leave whatever is there.
      const decision = decidedBy === "human" ? "reject" : "auto_reject";
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, reviewed_at = ?, decision = ?, decided_at = ?, decided_by = ?, send_started_at = NULL ${input.notes !== undefined ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes !== undefined
            ? [input.status, now, decision, now, decidedBy, input.notes, input.id]
            : [input.status, now, decision, now, decidedBy, input.id]),
        );
    } else {
      this.db
        .prepare(`UPDATE target_queue SET status = ?, send_started_at = NULL WHERE id = ?`)
        .run(input.status, input.id);
    }
  }

  /**
   * Fired after a guarded approved/pending UPDATE affects 0 rows: the row
   * may simply not exist (fine, matches the pre-#561 no-op behavior for an
   * unknown id) or it may have been excluded by the sent-row guard in the
   * WHERE clause. Only the latter throws.
   */
  private throwIfSentRowGuardBlocked(changes: number, id: number, status: QueueStatus): void {
    if (changes > 0) return;
    const current = this.db
      .query("SELECT status, sent_at FROM target_queue WHERE id = ?")
      .get(id) as { status: QueueStatus; sent_at: string | null } | undefined;
    if (current && (current.status === "sent" || current.sent_at != null)) {
      throw new Error(
        `setQueueStatus: row #${id} was already sent — refusing to move it to '${status}' (would re-send on the next drain)`,
      );
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
    const markerWhere = input.staleCutoffIso
      ? "(send_started_at IS NULL OR send_started_at < ?)"
      : "send_started_at IS NULL";
    const args: Array<string | number> = [input.startedAtIso, input.id];
    if (input.staleCutoffIso) args.push(input.staleCutoffIso);
    const result = this.db
      .prepare(
        // sent_at IS NULL is belt-and-braces alongside status = 'approved' —
        // the same guard setQueueStatus and dequeueApproved apply, closed
        // here too so a row desynced back to 'approved' with a stale
        // sent_at can't be claimed and re-sent through this path (#561).
        `UPDATE target_queue SET send_started_at = ?
         WHERE id = ? AND status = 'approved' AND sent_at IS NULL AND ${markerWhere}`,
      )
      .run(...args);
    return result.changes > 0;
  }

  clearQueueSendingMarker(id: number): void {
    this.db.prepare(`UPDATE target_queue SET send_started_at = NULL WHERE id = ?`).run(id);
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
    // `sent_at IS NULL` is belt-and-braces alongside `status = 'pending'` —
    // a pending row should never carry a sent_at, but the invariant lives
    // here, not in the caller (#561).
    const where: string[] = ["status = 'pending'", "sent_at IS NULL"];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    // decided_by='human_bulk': a human sanctioned the batch, but no per-row
    // judgment happened — evaluation code can include or exclude these
    // explicitly instead of reverse-engineering shared timestamps.
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'approved', reviewed_at = ?, decision = 'approve', decided_at = ?, decided_by = 'human_bulk' WHERE ${where.join(" AND ")}`,
      )
      .run(...([now, now, ...args] as never[]));
    return Number(result.changes);
  }

  /**
   * Atomic claim-and-return: SELECT + `drain_claimed_at` UPDATE in one
   * transaction so concurrent drains can't overlap. 15-min lease self-heals a
   * crashed drain; held/error rows back off for the lease duration.
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
           WHERE play_name = ? AND status = 'approved' AND sent_at IS NULL
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

  /**
   * Approved-row count per play, across the whole queue. Deliberately ignores
   * any status/play filter the caller is showing: /queue's drain button needs
   * to know a play has drainable rows even when the visible page is filtered
   * to `pending`. Plays with zero approved rows are absent from the map.
   */
  approvedCountsByPlay(): Record<string, number> {
    const rows = this.db
      .query(
        "SELECT play_name, COUNT(*) AS n FROM target_queue WHERE status = 'approved' GROUP BY play_name",
      )
      .all() as Array<{ play_name: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.play_name] = r.n;
    return out;
  }

  /** Reviewed queue outcomes for one finder inside a trailing time window. */
  finderApprovalStats(input: { finder: string; sinceIso: string }): {
    approved: number;
    reviewed: number;
    rate: number | null;
  } {
    // post-funding-auto predates the registry name and writes find:post-funding.
    const sourceName = input.finder === "post-funding-auto" ? "post-funding" : input.finder;
    const source = `find:${sourceName}`;
    const row = this.db
      .query(
        `SELECT
           SUM(CASE WHEN status IN ('approved','sent') THEN 1 ELSE 0 END) AS approved,
           COUNT(*) AS reviewed
         FROM target_queue
         WHERE (source = ? OR source LIKE ?)
           AND ${humanDecisionWhereSql()}
           AND reviewed_at >= ?`,
      )
      .get(source, `${source}:%`, input.sinceIso) as {
      approved: number | null;
      reviewed: number;
    };
    const approved = row.approved ?? 0;
    const reviewed = row.reviewed ?? 0;
    return { approved, reviewed, rate: reviewed > 0 ? approved / reviewed : null };
  }

  /**
   * Associate a queued target with a known prospect (so the queue page can
   * link back to the prospect record). Only the row's own `prospect_id`
   * write lives here — `Ledger.setQueueProspectId` keeps the best-effort
   * mail-address seeding, which reaches into the prospect/mail-address
   * domains this store doesn't own.
   */
  setQueueProspectId(id: number, prospectId: number): void {
    this.db.prepare(`UPDATE target_queue SET prospect_id = ? WHERE id = ?`).run(prospectId, id);
  }

  /** Save a generated draft only if no concurrent edit/send changed its inputs. */
  setQueueDraftIfCurrent(input: {
    id: number;
    previousDraft: string | null;
    previousPayload: string;
    draft: Parameters<QueueStore["setQueueDraft"]>[0]["draft"];
  }): boolean {
    const at = new Date().toISOString();
    return (
      this.db
        .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ?
      WHERE id = ? AND last_draft_json IS ? AND payload_json = ?
      AND status != 'sent' AND sent_at IS NULL AND send_started_at IS NULL`)
        .run(
          JSON.stringify({ ...input.draft, draftedAt: at }),
          at,
          input.id,
          input.previousDraft,
          input.previousPayload,
        ).changes === 1
    );
  }

  /**
   * Persist the most-recent draft for this queue row (the /run page is
   * ephemeral; /queue reviews from here). Most-recent-wins — re-runs
   * overwrite without history.
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
      angle?: unknown;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ? WHERE id = ?`)
      .run(json, draftedAtIso, input.id);
  }

  /**
   * Overwrite a queue row's `payload_json`. Manual add-prospect flow: the row
   * is enqueued as a placeholder, then rewritten with the researched dossier
   * so regenerate re-drafts without paying for research again.
   */
  updateQueuePayload(input: { id: number; payload: unknown }): void {
    this.db
      .prepare(`UPDATE target_queue SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(input.payload), input.id);
  }

  /**
   * The payload of the most recent SENT queue row for this play and address —
   * how a follow-up recovers the edge the intro drew its angle from (issue
   * #584), whichever path sent it (drain, /queue send-draft, mark-sent). Null
   * when nothing was sent to them on this play, or the payload won't parse.
   */
  latestSentQueuePayload(playName: string, email: string): Record<string, unknown> | null {
    const row = this.db
      .query(
        `SELECT payload_json FROM target_queue
          WHERE play_name = ? AND status = 'sent'
            AND lower(trim(json_extract(payload_json, '$.email'))) = lower(trim(?))
          ORDER BY sent_at DESC, id DESC LIMIT 1`,
      )
      .get(playName, email) as { payload_json: string } | null;
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * `latestSentQueuePayload` for a whole page of cadences at once (issue
   * #599): one query over the sent rows of the plays involved, newest first,
   * keeping the first row per `play|email`. Keyed exactly like the single-row
   * lookup canonicalises (lower-cased, trimmed email). Pairs with no email are
   * skipped; an empty input touches nothing. Never throws — `json_valid`
   * keeps a malformed row out of `json_extract` (which would fail the whole
   * query), so a bad payload is simply absent from the map.
   */
  latestSentQueuePayloads(
    pairs: ReadonlyArray<{ playName: string; email: string | null }>,
  ): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    const wanted = new Set<string>();
    const plays = new Set<string>();
    for (const p of pairs) {
      const email = p.email?.trim().toLowerCase();
      if (!email) continue;
      wanted.add(`${p.playName}|${email}`);
      plays.add(p.playName);
    }
    if (wanted.size === 0) return out;
    const playList = [...plays];
    const rows = this.db
      .query(
        `SELECT play_name, lower(trim(json_extract(payload_json, '$.email'))) AS email, payload_json
           FROM target_queue
          WHERE status = 'sent' AND json_valid(payload_json)
            AND play_name IN (${playList.map(() => "?").join(",")})
          ORDER BY sent_at DESC, id DESC`,
      )
      .all(...playList) as Array<{ play_name: string; email: string | null; payload_json: string }>;
    for (const row of rows) {
      if (!row.email) continue;
      const key = `${row.play_name}|${row.email}`;
      if (!wanted.has(key) || out.has(key)) continue;
      try {
        const parsed: unknown = JSON.parse(row.payload_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.set(key, parsed as Record<string, unknown>);
        }
      } catch {
        // an unparsable payload is no reminder; the row simply has none
      }
      if (out.size === wanted.size) break;
    }
    return out;
  }

  /**
   * Merge a few keys into a LIVE queue row's payload (issue #592) — pending or
   * approved, not sent, not mid-send. One statement, so there is no window
   * between checking eligibility and writing: a row that got sent between the
   * caller's listing and this call is simply not updated, and the caller is
   * told. `updateQueuePayload` above has no guard and stays for the paths that
   * own their row (the manual add's research rewrite).
   */
  patchLiveQueuePayload(input: { id: number; patch: Record<string, unknown> }): boolean {
    const r = this.db
      .prepare(
        `UPDATE target_queue
            SET payload_json = json_patch(payload_json, ?)
          WHERE id = ?
            AND status IN ('pending', 'approved')
            AND sent_at IS NULL
            AND send_started_at IS NULL
            AND json_valid(payload_json)`,
      )
      .run(JSON.stringify(input.patch), input.id);
    return r.changes === 1;
  }

  latestQueueId(): number {
    const row = this.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM target_queue").get() as {
      id: number;
    };
    return row.id;
  }

  /** Newly-created pending rows, used by the post-finder product research stage. */
  listPendingQueueAfterId(id: number): QueueRow[] {
    return this.db
      .query("SELECT * FROM target_queue WHERE id > ? AND status = 'pending' ORDER BY id ASC")
      .all(id) as QueueRow[];
  }

  /**
   * Set a queue row's `notes` without touching its status. Used by the manual
   * add-prospect flow to update the transient "researching profile…" note to
   * a "no email found" flag (or a research-failed message) once the async job
   * settles. Pass an empty string to clear it.
   */
  setQueueNotes(input: { id: number; notes: string }): void {
    this.db
      .prepare(`UPDATE target_queue SET notes = ? WHERE id = ?`)
      .run(input.notes === "" ? null : input.notes, input.id);
  }

  /**
   * Overwrite a queue row's shadow priority (the `score-prospects` backfill
   * writer). Pass null to clear.
   */
  setQueuePriority(id: number, priority: ProspectPriority | null): void {
    this.db
      .prepare(`UPDATE target_queue SET priority_json = ? WHERE id = ?`)
      .run(priority ? JSON.stringify(priority) : null, id);
  }

  /**
   * Rows the score-prospects backfill considers: pending + approved. Approved
   * implies unsent — a dispatched row moves to status 'sent'. id-ascending so
   * an interrupted run resumes deterministically.
   */
  listQueueRowsForScoring(
    opts: { playName?: string; limit?: number; allStatuses?: boolean } = {},
  ): QueueRow[] {
    const args: unknown[] = [];
    // Default scope is the live queue; `allStatuses` widens to full history so
    // scores can be compared against dispositions already made (methodology
    // evaluation) — it never changes what any consumer DOES with a score.
    let where = opts.allStatuses ? `1=1` : `status IN ('pending','approved')`;
    if (opts.playName) {
      where += ` AND play_name = ?`;
      args.push(opts.playName);
    }
    // Unbounded by default: the caller filters already-scored rows AFTER this
    // read, so a default LIMIT would pin every run to the same prefix and rows
    // past it could never be reached.
    let limitSql = "";
    if (opts.limit !== undefined) {
      limitSql = ` LIMIT ?`;
      args.push(opts.limit);
    }
    return this.db
      .query(`SELECT * FROM target_queue WHERE ${where} ORDER BY id ASC${limitSql}`)
      .all(...(args as never[])) as QueueRow[];
  }

  /**
   * Every sent queue row joined to its outcome evidence (Phase 3 of #410).
   * The prospect link is `prospect_id` when the post-send backfill caught it,
   * else an email join (LOWER/TRIM defeats the index — acceptable, this is an
   * offline report path over hundreds of rows). `COALESCE(kind,'human')` is
   * mandatory: pre-v23 replies have NULL kind and read as human everywhere.
   * `deal_lost`/`ghosted` map to no rank on purpose — deal_outcomes is
   * positives-only by construction (the cadences modal offers only the three
   * positive states), so its absence is never evidence of failure.
   */
  listSentOutcomeRows(opts: { playName?: string } = {}): SentOutcomeRawRow[] {
    const args: unknown[] = [];
    let where = `q.status = 'sent' AND q.sent_at IS NOT NULL`;
    if (opts.playName) {
      where += ` AND q.play_name = ?`;
      args.push(opts.playName);
    }
    return this.db
      .query(
        `SELECT q.id, q.play_name, q.dedupe_key, q.priority_json, q.sent_at,
                q.decision, q.decided_by,
                COALESCE(q.prospect_id, p.id) AS joined_prospect_id,
                json_extract(q.payload_json, '$.email') AS payload_email,
                (SELECT MIN(ir.received_at) FROM inbox_replies ir
                  WHERE ir.prospect_id = COALESCE(q.prospect_id, p.id)
                    AND COALESCE(ir.kind, 'human') = 'human') AS first_email_reply_at,
                (SELECT ir.intent FROM inbox_replies ir
                  WHERE ir.prospect_id = COALESCE(q.prospect_id, p.id)
                    AND COALESCE(ir.kind, 'human') = 'human'
                  ORDER BY ir.received_at ASC, ir.id ASC LIMIT 1) AS first_email_reply_intent,
                (SELECT MIN(ce.occurred_at) FROM channel_events ce
                  WHERE ce.prospect_id = COALESCE(q.prospect_id, p.id)
                    AND ce.event_type = 'reply') AS first_channel_reply_at,
                (SELECT MAX(CASE d.outcome WHEN 'deal_won' THEN 4
                                           WHEN 'sql_qualified' THEN 3
                                           WHEN 'meeting_booked' THEN 2
                                           ELSE NULL END)
                   FROM deal_outcomes d
                  WHERE d.prospect_id = COALESCE(q.prospect_id, p.id)) AS deal_rank
         FROM target_queue q
         LEFT JOIN prospects p
           ON p.email = LOWER(TRIM(json_extract(q.payload_json, '$.email')))
         WHERE ${where}
         ORDER BY q.id ASC`,
      )
      .all(...(args as never[])) as SentOutcomeRawRow[];
  }

  /**
   * Expire live `breakup-revive` queue rows for a prospect who just replied
   * (via any channel) — a reply means the revive attempt worked or the
   * relationship moved on either way, so the queued follow-up would be
   * stale. Matches by prospect id (linked rows) OR the play's own
   * `prospect:<id>` dedupe key (rows enqueued before linking). Called from
   * `Ledger`'s reply-handling methods (`recordLinkedInReply`,
   * `recordProspectReply`), which live outside this store's domain — but the
   * write itself only ever touches `target_queue`, so it lives here.
   */
  expireBreakupReviveQueue(prospectId: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE target_queue
         SET status = 'expired',
             notes = CASE WHEN notes IS NULL OR notes = '' THEN ?
                          ELSE notes || ' · ' || ? END
         WHERE (prospect_id = ? OR dedupe_key = ?)
           AND play_name = 'breakup-revive'
           AND status IN ('pending', 'approved')`,
      )
      .run(`expired: ${reason}`, `expired: ${reason}`, prospectId, `prospect:${prospectId}`);
  }
}
