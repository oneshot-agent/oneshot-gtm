import type { QueueRow } from "./types.ts";

/**
 * THE single definition of "a human decided this queue row" — shared by the
 * shadow-score gauge, finder approval stats, and ICP few-shot selection so
 * they can never drift apart (each had hand-rolled copies before; one missed
 * the auto: clause, one counted expiry timeouts as rejections).
 *
 * A human decision is: reviewed, terminal-by-review status, and not a machine
 * rejection (`auto:` notes prefix — ICP/role gates, import classifiers).
 *
 * `expired` is deliberately NOT a human status even when reviewed_at is set:
 * reservation inserts (csv-import), bulk stamps, and cadence-stop expiry all
 * write reviewed_at without any per-row judgment. Known lossy edge: a row a
 * human approved that machinery later expires (e.g. stopCadence on
 * breakup-revive) loses its label — current-status is a lossy record of the
 * decision history; a disposition-provenance column is the Phase 3 fix.
 */
export function isHumanDecision(row: Pick<QueueRow, "status" | "notes" | "reviewed_at">): boolean {
  if (row.reviewed_at === null) return false;
  if (row.status === "approved" || row.status === "sent") return true;
  return row.status === "rejected" && !(row.notes ?? "").startsWith("auto:");
}

/** True when a human decision was a yes (approve, or approve-then-send). */
export function isHumanApproval(row: Pick<QueueRow, "status" | "notes" | "reviewed_at">): boolean {
  return isHumanDecision(row) && (row.status === "approved" || row.status === "sent");
}

/**
 * The same predicate as SQL, for queries that must filter in the database.
 * `prefix` qualifies columns when the query aliases target_queue (e.g. "q.").
 */
export function humanDecisionWhereSql(prefix = ""): string {
  const p = prefix;
  // COALESCE matters: `NULL LIKE 'auto:%'` is NULL, and `NOT (… AND NULL)`
  // is NULL too — without it a notes-less human rejection silently drops out
  // of the result set (three-valued logic; this bug shipped in
  // recentIcpDecisions before the predicate was unified here).
  return (
    `${p}reviewed_at IS NOT NULL` +
    ` AND ${p}status IN ('approved','rejected','sent')` +
    ` AND NOT (${p}status = 'rejected' AND COALESCE(${p}notes, '') LIKE 'auto:%')`
  );
}
