import { PRIORITY_WEIGHTS_BY_VERSION, type ProspectPriorityView } from "@oneshot-gtm/shared-types";

/**
 * Display logic for the shadow-mode priority score (issue #410). Pure so it's
 * testable without a DOM, like `drainButton.ts`. The chip is informational
 * only — no sort, no filter, no gate — and its tones deliberately stop short
 * of "blocked": a low shadow score is not a rejection.
 */

export type PriorityTone = "signal" | "neutral" | "receipt";

export interface PriorityChip {
  /** Compact badge text, e.g. "72 · shadow". */
  label: string;
  tone: PriorityTone;
  /** Hover text: top reasons joined, or a fallback when the artifact has none. */
  title: string;
}

const MAX_TITLE_REASONS = 4;

/**
 * `masked` = privacy mode: reason strings are freeform and can embed names
 * and companies the structured `<Pii>` masking can't reach, so under the mask
 * they are suppressed entirely (the numeric score is not identifying).
 */
export function priorityChip(p: ProspectPriorityView | null, masked = false): PriorityChip | null {
  if (!p) return null;
  const tone: PriorityTone = p.total >= 70 ? "signal" : p.total >= 40 ? "neutral" : "receipt";
  const reasons = masked
    ? []
    : p.reasons.filter((r) => r.trim() !== "").slice(0, MAX_TITLE_REASONS);
  return {
    label: `${p.total} · shadow`,
    tone,
    title: reasons.length > 0 ? reasons.join(" · ") : `experimental priority score (${p.finder})`,
  };
}

export interface PriorityBreakdownRow {
  /** Human label, e.g. "person fit". */
  component: string;
  score: number;
  weightPct: number;
}

/**
 * Display order and labels only — the weights come from the canonical
 * per-version table in shared-types, so a v1 artifact renders v1's weights
 * and a v2 artifact v2's, and nothing here can drift from the engine.
 */
const BREAKDOWN: Array<{ key: keyof ProspectPriorityView["components"]; label: string }> = [
  { key: "personFit", label: "person fit" },
  { key: "accountFit", label: "account fit" },
  { key: "intentStrength", label: "intent" },
  { key: "timingFreshness", label: "freshness" },
  { key: "signalConfidence", label: "confidence" },
  { key: "contactability", label: "contactability" },
];

export function priorityBreakdown(p: ProspectPriorityView): PriorityBreakdownRow[] {
  const weights = PRIORITY_WEIGHTS_BY_VERSION[p.version];
  return BREAKDOWN.map((b) => ({
    component: b.label,
    score: p.components[b.key],
    weightPct: weights[b.key],
  }));
}
