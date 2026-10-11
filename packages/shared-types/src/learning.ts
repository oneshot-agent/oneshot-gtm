/**
 * Unified learning proposals (issue #813). Four kinds of learned change —
 * a writing preference, a prospect's angle, a play's configured angle set,
 * and the ICP one-liner — share one review surface and one rule: nothing
 * takes effect before the founder approves it. The ICP proposals of #750
 * are the `icp` kind of this model.
 */

export type LearningKind = "preference" | "prospect_angle" | "campaign_angle" | "icp";

/**
 * `stale` is a pending proposal superseded by an approval against the same
 * baseline (its "current" snapshot no longer matches what is active);
 * `rolled_back` is an approval the founder later reverted.
 */
export type LearningProposalStatus = "pending" | "approved" | "dismissed" | "stale" | "rolled_back";

export type LearningChannel = "email" | "linkedin";
export type LearningStage = "first_touch" | "follow_up" | "reply";

/** Where a proposal applies. Absent fields mean "any". */
export interface LearningScope {
  channel?: LearningChannel;
  stage?: LearningStage;
  prospectId?: number;
  playName?: string;
}

export interface LearningEvidenceRef {
  type:
    | "evidence_snapshot"
    | "reply_send"
    | "draft_version"
    | "queue_decision"
    | "deal_outcome"
    | "inbox_reply"
    | "channel_event";
  id: string | number;
  label?: string;
}

/** A displayable excerpt of what the proposal was learned from; never an instruction. */
export interface LearningEvidenceSample {
  original?: string | null;
  sent?: string;
  feedback?: string[];
  at?: string;
  name?: string;
  channel?: LearningChannel;
  stage?: LearningStage;
  /** A free-form excerpt (a reply, a signal) with its own label, for evidence that is not a draft. */
  label?: string;
  text?: string;
}

export interface LearningEvidence {
  refs: LearningEvidenceRef[];
  samples?: LearningEvidenceSample[];
  /** Named counts behind the proposal (decisions, outcomes, offered/sent/replied per angle). */
  counts?: Record<string, number>;
  /** How the evidence was selected or assigned (e.g. `fit`, `arm`, `reply`, `outcome`). */
  method?: string;
}

export interface LearningProposalView {
  id: string;
  kind: LearningKind;
  scope: LearningScope;
  /** The active value when the proposal was generated; what a rollback restores. */
  current: unknown;
  proposed: unknown;
  evidence: LearningEvidence;
  evidenceSummary: string;
  /** Fingerprint of `current`; approval is refused when the active value no longer matches. */
  baselineKey: string;
  dedupeKey: string;
  status: LearningProposalStatus;
  /** Learned before approval existed and migrated into review, never applied since. */
  legacy: boolean;
  /** Display name for the scope, resolved at read time: the prospect's name for a prospect angle, the play for campaign angles. */
  scopeLabel?: string | null;
  sourceVersion: number | null;
  createdAt: string;
  decidedAt: string | null;
  /** The founder's edited value when approved with changes; null when approved as proposed. */
  decided: unknown;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

export type LearningGuidanceStatus = "enabled" | "disabled" | "rolled_back";

/** An approved writing preference, applied to drafts whose channel/stage it matches. */
export interface LearningGuidanceView {
  id: string;
  instruction: string;
  source: "explicit" | "edits" | "style";
  channel: LearningChannel | null;
  stage: LearningStage | null;
  proposalId: string | null;
  evidence: LearningEvidence;
  status: LearningGuidanceStatus;
  approvedAt: string;
  updatedAt: string;
}

export interface LearningProposalsResult {
  proposals: LearningProposalView[];
}

export interface LearningGuidanceResult {
  version: number;
  guidance: LearningGuidanceView[];
}

export interface LearningDecisionResult {
  ok: true;
  proposal: LearningProposalView;
}

/** `POST /api/triggers/:name/suggest-angles`: a proposal, or why none was made. */
export interface AngleSuggestionResult {
  ok: true;
  proposal: LearningProposalView | null;
  /** Present when no proposal was created: the model kept the set, or an identical one is pending. */
  reason?: string;
}

/**
 * Optional structured reason on a queue decision. Only `fit`, `wrong_audience`
 * and `wrong_person` are judgments about customer fit; the rest are about the
 * draft, the moment, or a relationship that already exists, and never feed
 * ICP evidence.
 */
export const DECISION_REASONS = [
  "fit",
  "wrong_audience",
  "wrong_person",
  "bad_timing",
  "already_contacted",
  "draft_problem",
  "other",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];
export const FIT_DECISION_REASONS: ReadonlyArray<DecisionReason> = [
  "fit",
  "wrong_audience",
  "wrong_person",
];
export function isDecisionReason(value: unknown): value is DecisionReason {
  return typeof value === "string" && (DECISION_REASONS as ReadonlyArray<string>).includes(value);
}
