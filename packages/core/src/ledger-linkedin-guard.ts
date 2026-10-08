import type { Database } from "bun:sqlite";
import { contactAllowedClause } from "./contact-optout.ts";
import type { LinkedInGuardFacts } from "./linkedin-guard.ts";

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/**
 * What the LinkedIn invite guard reads about one prospect: opt-out, any reply
 * that counts as engagement, a stopped/unsubscribed cadence, the ICP verdict.
 * Null when the prospect row doesn't exist.
 *
 * An out-of-office (`inbox_replies.kind = 'auto'`) is not engagement. A dead
 * mailbox (`auto_permanent`) and an unsubscribe are.
 */
export function linkedInGuardFacts(db: Database, prospectId: number): LinkedInGuardFacts | null {
  const prospect = db
    .query("SELECT id, icp_verdict FROM prospects WHERE id = ?")
    .get(prospectId) as { id: number; icp_verdict: string | null } | null;
  if (!prospect) return null;
  const optedOut =
    db
      .query(`SELECT 1 FROM prospects p WHERE p.id = ? AND NOT (${contactAllowedClause(db)})`)
      .get(prospectId) != null;
  const emailReply = hasTable(db, "inbox_replies")
    ? db
        .query(
          `SELECT 1 FROM inbox_replies ir
           WHERE ir.prospect_id = ? AND COALESCE(ir.kind, 'human') != 'auto' LIMIT 1`,
        )
        .get(prospectId) != null
    : false;
  const channelReply = hasTable(db, "channel_events")
    ? db
        .query(
          `SELECT 1 FROM channel_events WHERE prospect_id = ? AND event_type = 'reply' LIMIT 1`,
        )
        .get(prospectId) != null
    : false;
  const cadenceStopped = hasTable(db, "cadence_state")
    ? db
        .query(
          `SELECT 1 FROM cadence_state
           WHERE prospect_id = ? AND status IN ('stopped', 'unsubscribed') LIMIT 1`,
        )
        .get(prospectId) != null
    : false;
  return {
    optedOut,
    emailReply,
    channelReply,
    cadenceStopped,
    icpVerdict: prospect.icp_verdict,
  };
}
