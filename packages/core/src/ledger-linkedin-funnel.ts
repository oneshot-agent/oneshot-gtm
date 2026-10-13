import type { Database } from "bun:sqlite";
import { LINKEDIN_INVITE_KIND } from "./ledger-cadence.ts";

/**
 * What the LinkedIn funnel (#792) reads from a workspace ledger: every
 * sequence event of a prospect who was ever sent a LinkedIn invite, the
 * prospects themselves, and their LinkedIn reply events. Read-only.
 */

export interface FunnelEventRow {
  id: number;
  prospect_id: number;
  play_name: string;
  step_index: number;
  channel: string;
  status: string;
  metadata_json: string | null;
  created_at: string;
}

export interface FunnelProspectRow {
  id: number;
  name: string | null;
  linkedin_url: string | null;
}

export interface FunnelReplyRow {
  id: number;
  prospect_id: number;
  /** `oneshot-linkedin` for GTM's own sync; anything else is an older capture. */
  source: string;
  occurred_at: string;
  body: string | null;
}

export interface LinkedInFunnelSource {
  events: FunnelEventRow[];
  prospects: FunnelProspectRow[];
  replies: FunnelReplyRow[];
}

// The same rule `listLinkedInInviteEvents` applies: a marked invite at any
// step, or a legacy LinkedIn row at step 0.
const INVITED_PROSPECTS = `
  SELECT DISTINCT prospect_id FROM sequence_events
   WHERE channel = 'linkedin'
     AND (step_index = 0
          OR CASE WHEN json_valid(metadata_json)
                  THEN json_extract(metadata_json, '$.kind') END = ?)`;

export function readLinkedInFunnelSource(db: Database): LinkedInFunnelSource {
  const events = db
    .query(
      `SELECT id, prospect_id, play_name, step_index, channel, status, metadata_json, created_at
         FROM sequence_events
        WHERE prospect_id IN (${INVITED_PROSPECTS})
        ORDER BY id ASC`,
    )
    .all(LINKEDIN_INVITE_KIND) as FunnelEventRow[];
  const prospects = db
    .query(
      `SELECT id, name, linkedin_url FROM prospects WHERE id IN (${INVITED_PROSPECTS}) ORDER BY id ASC`,
    )
    .all(LINKEDIN_INVITE_KIND) as FunnelProspectRow[];
  const replies = db
    .query(
      `SELECT id, prospect_id, source, occurred_at, body
         FROM channel_events
        WHERE channel = 'linkedin' AND event_type = 'reply'
          AND prospect_id IN (${INVITED_PROSPECTS})
        ORDER BY occurred_at ASC, id ASC`,
    )
    .all(LINKEDIN_INVITE_KIND) as FunnelReplyRow[];
  return { events, prospects, replies };
}
