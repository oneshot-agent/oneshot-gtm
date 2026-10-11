import type { Database } from "bun:sqlite";
import { contactAllowedClause } from "./contact-optout.ts";
import { LINKEDIN_INVITE_KIND } from "./ledger-cadence.ts";
import { normalizeLinkedInProfile, type LinkedInGuardFacts } from "./linkedin-guard.ts";

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/**
 * Every LinkedIn invite this ledger has recorded (the send events, found the
 * way `listLinkedInInviteEvents` finds them), as normalised profile slugs with
 * the time of the first one. Feeds the one-time backfill of `linkedin_touched`.
 */
export function linkedInInviteHistory(db: Database): Array<{ slug: string; touchedAt: string }> {
  const rows = db
    .query(
      `SELECT p.linkedin_url AS url, MIN(se.created_at) AS at
         FROM sequence_events se
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.channel = 'linkedin' AND se.status IN ('sent', 'delivered', 'replied')
          AND p.linkedin_url IS NOT NULL
          AND (
            se.step_index = 0
            OR CASE WHEN json_valid(se.metadata_json)
                    THEN json_extract(se.metadata_json, '$.kind') END = ?
          )
        GROUP BY p.id`,
    )
    .all(LINKEDIN_INVITE_KIND) as Array<{ url: string; at: string }>;
  const bySlug = new Map<string, string>();
  for (const r of rows) {
    const profile = normalizeLinkedInProfile(r.url);
    if (!profile) continue;
    const prev = bySlug.get(profile.key);
    if (!prev || r.at < prev) bySlug.set(profile.key, r.at);
  }
  return [...bySlug].map(([slug, at]) => ({
    slug,
    touchedAt: new Date(`${at.replace(" ", "T")}${at.includes("Z") ? "" : "Z"}`).toISOString(),
  }));
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
