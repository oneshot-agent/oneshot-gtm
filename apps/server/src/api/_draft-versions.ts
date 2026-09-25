import {
  angleTextKey,
  getLedger,
  type AngleUsageRow,
  type DraftUsage,
  type DraftUsageByStep,
  type DraftVersionRow,
} from "@oneshot-gtm/core";
import { edgeFieldOf, splitEdgeAngles } from "@oneshot-gtm/plays";
import type {
  AngleUsageView,
  DraftUsageView,
  DraftVersionView,
  VoiceUsageView,
} from "@oneshot-gtm/shared-types";

/**
 * Wire projections of the draft-version record (packages/core/src/ledger-drafts.ts):
 * the per-row history the queue and cadence pages show, and the per-play
 * tallies the trigger editor shows next to `yourEdge`.
 */

export function toDraftVersionView(row: DraftVersionRow): DraftVersionView {
  let flags: string[] = [];
  if (row.flags_json) {
    try {
      const parsed: unknown = JSON.parse(row.flags_json);
      if (Array.isArray(parsed)) flags = parsed.filter((f): f is string => typeof f === "string");
    } catch {
      flags = [];
    }
  }
  return {
    id: row.id,
    stepIndex: row.step_index,
    subject: row.subject,
    body: row.body,
    flags,
    angle:
      row.angle_text && row.angle_origin
        ? { text: row.angle_text, origin: row.angle_origin }
        : null,
    outcome: row.outcome,
    discardReason: row.discard_reason,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export interface PlayUsage {
  angles: AngleUsageRow[];
  drafts: DraftUsageByStep | undefined;
  voice: { voiced: DraftUsage; plain: DraftUsage } | undefined;
}

/** Read both aggregates once; hand out per-play slices. */
export function playUsageLoader(ledger: ReturnType<typeof getLedger>): (play: string) => PlayUsage {
  let angles: Record<string, AngleUsageRow[]> = {};
  let drafts: Record<string, DraftUsageByStep> = {};
  let voice: Record<string, { voiced: DraftUsage; plain: DraftUsage }> = {};
  try {
    angles = ledger.angleUsageByPlay();
    drafts = ledger.draftUsageByPlay();
    voice = ledger.draftUsageByVoice();
  } catch {
    // Test doubles and pre-v33 ledgers: the editor simply shows no tally.
  }
  return (play) => ({ angles: angles[play] ?? [], drafts: drafts[play], voice: voice[play] });
}

const ZERO: Omit<AngleUsageView, "text"> = {
  offered: 0,
  rotatedAway: 0,
  redrafted: 0,
  sent: 0,
  autoSent: 0,
  replied: 0,
  reached: 0,
};

function counts(r: AngleUsageRow): Omit<AngleUsageView, "text"> {
  return {
    offered: r.offered,
    rotatedAway: r.rotatedAway,
    redrafted: r.redrafted,
    sent: r.sent,
    autoSent: r.autoSent,
    replied: r.replied,
    reached: r.reached,
  };
}

/**
 * Map the ledger's per-angle rows onto the trigger's CURRENT edge, in config
 * order, keyed by normalized text so an edited index cannot mis-assign a
 * count. Angles no longer in the edge drop out of the view (their rows stay
 * in the ledger); generated alternatives sum into one bucket. Null when the
 * config carries no edge field at all.
 */
export function angleUsageForEdge(
  config: Record<string, unknown> | null,
  rows: AngleUsageRow[],
): { angles: AngleUsageView[]; generated: AngleUsageView } | null {
  if (!config) return null;
  const field = edgeFieldOf(config);
  if (!field) return null;
  const configured = splitEdgeAngles(config[field] as string);
  if (configured.length === 0) return null;
  const byKey = new Map(rows.map((r) => [r.angleKey, r]));
  const angles: AngleUsageView[] = [];
  for (const text of configured) {
    const row = byKey.get(angleTextKey(text));
    const c = row ? counts(row) : ZERO;
    angles.push({
      text,
      offered: c.offered,
      rotatedAway: c.rotatedAway,
      redrafted: c.redrafted,
      sent: c.sent,
      autoSent: c.autoSent,
      replied: c.replied,
      reached: c.reached,
    });
  }
  const generated: AngleUsageView = { text: "generated", ...ZERO };
  for (const r of rows) {
    if (r.origin !== "generated") continue;
    generated.offered += r.offered;
    generated.rotatedAway += r.rotatedAway;
    generated.redrafted += r.redrafted;
    generated.sent += r.sent;
    generated.autoSent += r.autoSent;
    generated.replied += r.replied;
    generated.reached += r.reached;
  }
  return { angles, generated };
}

function usageView(u: DraftUsage): DraftUsageView {
  return {
    open: u.open,
    regenerated: u.regenerated,
    rotated: u.rotated,
    sent: u.sent,
    autoSent: u.autoSent,
    replied: u.replied,
  };
}

export function draftUsageView(
  drafts: DraftUsageByStep | undefined,
): { intro: DraftUsageView; followUp: DraftUsageView } | null {
  if (!drafts) return null;
  return { intro: usageView(drafts.intro), followUp: usageView(drafts.followUp) };
}

export function voiceUsageView(
  voice: { voiced: DraftUsage; plain: DraftUsage } | undefined,
): VoiceUsageView | null {
  if (!voice) return null;
  return { voiced: usageView(voice.voiced), plain: usageView(voice.plain) };
}
