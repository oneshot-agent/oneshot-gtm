/** Learning-loop v2 (issue #750): periodic, founder-approved ICP rewrite proposals. */

export type IcpProposalStatus = "pending" | "approved" | "dismissed";

export interface IcpProposalView {
  id: string;
  /** The active ICP one-liner at the moment this proposal was generated. */
  currentIcp: string;
  /** The tighter one-liner derived from accumulated human decisions. */
  proposedIcp: string;
  /** Human-readable summary of the decisions that grounded this proposal. */
  evidenceSummary: string;
  createdAt: string;
  status: IcpProposalStatus;
  decidedAt: string | null;
}

export interface IcpProposalsResult {
  proposals: IcpProposalView[];
}

export interface IcpProposalDecisionResult {
  ok: true;
  /** The ICP now active in config, only present on approval. */
  icpOneLiner?: string;
}
