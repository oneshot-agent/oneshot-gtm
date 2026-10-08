import type {
  IcpProposalStatus,
  IcpProposalView,
  LearningProposalView,
} from "@oneshot-gtm/shared-types";
import { LearningStore, normalizeLearnedText } from "./learning-store.ts";

/**
 * Learning-loop v2 (issue #750): a periodic, rate-limited job proposes a
 * tighter ICP one-liner from accumulated human approve/reject decisions, but
 * the active ICP never changes without an explicit founder approval on
 * `/queue`. Since #813 this is the `icp` kind of the unified
 * `LearningStore` (learning-store.ts, ledger migration v13); this class is
 * the compatibility surface `icp-proposals.ts` and the `/api/icp-proposals`
 * routes keep calling. The v7 `icp_proposal_state` / `icp_proposals` tables
 * remain in the file but are no longer read.
 */

/** Same normalization `reply-learning-store.ts` uses for duplicate instruction text. */
export function normalizeIcpText(s: string): string {
  return normalizeLearnedText(s);
}

/** Default floor for `OneShotConfig.icpProposalMinDecisions` (config.ts's DEFAULTS). */
export const DEFAULT_ICP_PROPOSAL_MIN_DECISIONS = 30;

const JOB = "icp";

const asText = (v: unknown): string => (typeof v === "string" ? v : "");

/** The unified statuses `stale` and `rolled_back` fold into the v1 view's three. */
function toView(p: LearningProposalView): IcpProposalView {
  const status: IcpProposalStatus =
    p.status === "stale" ? "dismissed" : p.status === "rolled_back" ? "approved" : p.status;
  return {
    id: p.id,
    currentIcp: asText(p.current),
    proposedIcp: asText(p.decided ?? p.proposed),
    evidenceSummary: p.evidenceSummary,
    createdAt: p.createdAt,
    status,
    decidedAt: p.decidedAt,
  };
}

export class IcpProposalStore {
  constructor(private readonly learning: LearningStore) {}

  /**
   * Take the evaluation lease, gated by an in-progress lease and a cooldown
   * since the last attempt (successful or not). Callers must have already
   * confirmed there is enough evidence to justify a model call: taking the
   * lease also stamps the attempt, spending the cooldown window whether or
   * not a proposal is ultimately produced. Returns the lease token, or null
   * when a lease is already held or the cooldown hasn't elapsed.
   */
  beginEvaluation(now: number, cooldownMs: number, leaseMs: number): string | null {
    return this.learning.claimJob(JOB, now, { cooldownMs, leaseMs });
  }

  /** A live lease clears without producing a proposal: retried on the next cooldown. */
  fail(token: string, reason: string): void {
    this.learning.failJob(JOB, token, reason);
  }

  /** A completed evaluation, successful or a deliberate no-op: release the lease. */
  finish(token: string): boolean {
    return this.learning.finishJob(JOB, token);
  }

  /** True when a PENDING proposal already carries this normalized text: the de-dup guard. */
  hasPendingDuplicate(proposedIcp: string): boolean {
    return this.learning.hasPendingDuplicate("icp", normalizeIcpText(proposedIcp));
  }

  /**
   * True when the most recently decided ICP proposal — of ANY text — was a
   * dismissal of this exact (normalized) text, so an identical proposal
   * does not recur right after the founder said no to it; the ban lifts
   * once any later decision lands (see `LearningStore.wasJustDismissed`).
   */
  wasJustDismissed(proposedIcp: string): boolean {
    return this.learning.wasJustDismissed("icp", normalizeIcpText(proposedIcp));
  }

  insert(input: {
    currentIcp: string;
    proposedIcp: string;
    evidenceSummary: string;
    createdAt: string;
    evidence?: LearningProposalView["evidence"];
  }): IcpProposalView {
    const view = this.learning.insert({
      kind: "icp",
      current: input.currentIcp,
      proposed: input.proposedIcp,
      evidence: input.evidence ?? { refs: [] },
      evidenceSummary: input.evidenceSummary,
      baselineKey: normalizeIcpText(input.currentIcp),
      dedupeKey: normalizeIcpText(input.proposedIcp),
      createdAt: input.createdAt,
    });
    if (!view) throw new Error("An identical ICP proposal is already pending");
    return toView(view);
  }

  list(status?: IcpProposalStatus): IcpProposalView[] {
    const all = this.learning.list({ kind: "icp", status: "all" }).map(toView);
    return status ? all.filter((p) => p.status === status) : all;
  }

  get(id: string): IcpProposalView | null {
    const p = this.learning.get(id);
    return p && p.kind === "icp" ? toView(p) : null;
  }

  /** This surface only ever reaches ICP rows: an id of another kind reads as missing. */
  private isIcp(id: string): boolean {
    return this.learning.get(id)?.kind === "icp";
  }

  /**
   * Flip a PENDING proposal to `approved` or `dismissed`, guarded against a
   * concurrent double-decision (the UPDATE's own `WHERE status='pending'`
   * runs under the write lock).
   */
  decide(
    id: string,
    status: "approved" | "dismissed",
    now: string,
  ): { view: IcpProposalView } | { error: string } {
    if (!this.isIcp(id)) return { error: `proposal '${id}' not found` };
    const result = this.learning.decide(id, status, now);
    return "error" in result ? result : { view: toView(result.view) };
  }

  /**
   * Compensating action for the approval route: config.json couldn't be
   * updated after the approval was recorded, so put the proposal back to
   * pending rather than leave a recorded "approval" that never took effect.
   */
  revertToPending(id: string): void {
    if (this.isIcp(id)) this.learning.revertToPending(id);
  }

  /** The approval took effect on config.json. */
  markApplied(id: string, now: string): void {
    if (this.isIcp(id)) this.learning.markApplied(id, now);
  }

  /**
   * Called right after an approval successfully rewrites the active ICP:
   * every OTHER still-pending row was generated against the baseline this
   * approval just replaced, so none of them can still be approved as-is.
   * They read as dismissed on this surface (`stale` in the unified store).
   */
  dismissStalePending(now: string): void {
    this.learning.markStale("icp", "", now);
  }
}
