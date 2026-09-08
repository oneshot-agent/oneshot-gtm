import type { QueueRow } from "./types.ts";

type LabelRow = Pick<QueueRow, "status" | "notes" | "reviewed_at" | "decision" | "decided_by">;

/**
 * THE single definition of "a human decided this queue row" — shared by the
 * shadow-score gauge, finder approval stats, and ICP few-shot selection so
 * they can never drift apart (each had hand-rolled copies before; one missed
 * the auto: clause, one counted expiry timeouts as rejections).
 *
 * v26 makes this provenance-first: the `decision`/`decided_by` columns are
 * written at decision time and survive expiry and re-open — a reply that
 * expires an approved breakup-revive row no longer destroys the label. Rows
 * with NULL provenance (pre-v26, or never backfillable) fall back to the
 * status inference, same COALESCE-to-legacy pattern as `inbox_replies.kind`:
 * reviewed + terminal-by-review status + not an `auto:` machine rejection;
 * `expired` is never a human status there (reservation inserts, bulk stamps,
 * and cadence-stop expiry all write reviewed_at without per-row judgment).
 *
 * `human_bulk` (approve-all batches) COUNTS as a human decision — parity
 * with the status inference; evaluation code that wants per-row judgment
 * only filters `decided_by === "human"` explicitly.
 */
export function isHumanDecision(row: LabelRow): boolean {
  if (row.decision != null) {
    return (
      (row.decision === "approve" || row.decision === "reject") &&
      (row.decided_by === "human" || row.decided_by === "human_bulk")
    );
  }
  if (row.reviewed_at === null) return false;
  if (row.status === "approved" || row.status === "sent") return true;
  return row.status === "rejected" && !(row.notes ?? "").startsWith("auto:");
}

/** True when a human decision was a yes (approve, or approve-then-send). */
export function isHumanApproval(row: LabelRow): boolean {
  if (row.decision != null) return isHumanDecision(row) && row.decision === "approve";
  return isHumanDecision(row) && (row.status === "approved" || row.status === "sent");
}

/**
 * The same predicate as SQL, for queries that must filter in the database.
 * `prefix` qualifies columns when the query aliases target_queue (e.g. "q.").
 */
export function humanDecisionWhereSql(prefix = ""): string {
  const p = prefix;
  // Provenance arm first; the legacy arm is guarded by `decision IS NULL` so
  // a machine-stamped row can never fall through to the status inference.
  // COALESCE matters in the legacy arm: `NULL LIKE 'auto:%'` is NULL, and
  // `NOT (… AND NULL)` is NULL too — without it a notes-less human rejection
  // silently drops out of the result set (three-valued logic; this bug
  // shipped in recentIcpDecisions before the predicate was unified here).
  return (
    `( (${p}decision IN ('approve','reject') AND ${p}decided_by IN ('human','human_bulk'))` +
    ` OR (${p}decision IS NULL` +
    ` AND ${p}reviewed_at IS NOT NULL` +
    ` AND ${p}status IN ('approved','rejected','sent')` +
    ` AND NOT (${p}status = 'rejected' AND COALESCE(${p}notes, '') LIKE 'auto:%')) )`
  );
}
