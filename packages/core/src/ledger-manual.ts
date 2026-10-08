import type { Database } from "bun:sqlite";
import type { Ledger } from "./ledger.ts";
import { channelOf, firstTouchSender } from "./channels.ts";

export interface ManualQueueSend {
  id: number;
  profileUrl: string;
  name: string | null;
  /** Optimistic check: record precisely the draft the route reviewed. */
  draftJson: string;
  metadata: Record<string, unknown>;
}

/** One workspace transaction owns the confirmation, event, and draft closure.
 * The canonical public profile is enough; this does not resolve a real identity.
 */
export function recordManualQueueSend(
  db: Database,
  ledger: Ledger,
  input: ManualQueueSend,
): { prospectId: number } {
  return db
    .transaction(() => {
      const row = ledger.getQueueRow(input.id);
      if (!row) throw new Error("queue row not found");
      if (row.status === "sent" && row.prospect_id != null) return { prospectId: row.prospect_id };
      if (row.status !== "approved" || firstTouchSender(channelOf(row.channel)) !== "manual")
        throw new Error("approve a manual-channel row before recording it");
      if (row.last_draft_json !== input.draftJson)
        throw new Error("draft changed; refresh before recording it");
      const existing = db
        .query("SELECT id FROM prospects WHERE source_profile_url = ? ORDER BY id LIMIT 1")
        .get(input.profileUrl) as { id: number } | null;
      const prospectId =
        row.prospect_id ??
        existing?.id ??
        ledger.upsertProspect({
          name: input.name,
          email: null,
          ...(row.channel === "x" ? { linkedin_url: input.profileUrl } : {}),
          source: row.play_name,
          source_profile_url: input.profileUrl,
        });
      ledger.recordSequenceEvent({
        prospectId,
        playName: row.play_name,
        stepIndex: 0,
        channel: channelOf(row.channel),
        status: "sent",
        metadata: { ...input.metadata, queueId: row.id, manual: true },
      });
      ledger.setQueueProspectId(row.id, prospectId);
      ledger.setQueueStatus({ id: row.id, status: "sent", decidedBy: "human" });
      ledger.closeQueueDraftVersion(row.id, "sent");
      return { prospectId };
    })
    .immediate();
}
