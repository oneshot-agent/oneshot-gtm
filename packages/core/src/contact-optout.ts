import type { Database } from "bun:sqlite";

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/** Opt-outs override every campaign, including historical human/replied signals. */
export function contactAllowedClause(db: Database): string {
  const clauses: string[] = [];
  if (hasTable(db, "cadence_state"))
    clauses.push(`NOT EXISTS (
    SELECT 1 FROM cadence_state c WHERE c.prospect_id = p.id AND c.status = 'unsubscribed')`);
  if (
    hasTable(db, "inbox_replies") &&
    (db.query("PRAGMA table_info(inbox_replies)").all() as Array<{ name: string }>).some(
      (c) => c.name === "kind",
    )
  )
    clauses.push(`NOT EXISTS (
    SELECT 1 FROM inbox_replies ir WHERE ir.kind = 'unsubscribe'
      AND (ir.prospect_id = p.id OR lower(ir.from_email) = lower(p.email)))`);
  // Sync may have persisted a verdict before the cadence poll consumes it.
  if (
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_messages'").get()
  ) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM mailbox_messages m
      WHERE m.direction = 'inbound' AND json_extract(m.data, '$.kind') = 'unsubscribe'
        AND (m.prospect_id = p.id OR lower(json_extract(m.data, '$.from')) = lower(p.email)))`);
  }
  return clauses.length ? clauses.join(" AND ") : "1=1";
}

/** Cross-channel enrollment guard. The SQL clause expects the prospect alias `p`. */
export function isProspectOptedOut(db: Database, prospectId: number): boolean {
  return (
    db
      .query(`SELECT 1 FROM prospects p WHERE p.id = ? AND NOT (${contactAllowedClause(db)})`)
      .get(prospectId) != null
  );
}
