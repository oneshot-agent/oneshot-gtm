import {
  DEFAULT_ICP_PROPOSAL_MIN_DECISIONS,
  demoMode,
  getLedger,
  loadConfig,
  logEvent,
  normalizeIcpText,
  tryReserveDailySpend,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

/**
 * Learning-loop v2 (issue #750): scheduler-only synthesis, exactly like
 * `reply-learning.ts` — no drafting or send path waits for this. Periodically
 * derive a tighter ICP one-liner from accumulated human approve/reject
 * decisions (the same `recentIcpDecisions` few-shot examples `_filter.ts`
 * already draws on), but the active ICP itself is NEVER touched here: a
 * founder-approved proposal is the only thing that can change it (see
 * `apps/server/src/api/icp-proposals.ts`).
 */
const EVALUATION_COOLDOWN_MS = 24 * 60 * 60_000;
/** Generous: the model call + JSON parse is fast; this only bounds a crashed process's lease. */
const EVALUATION_LEASE_MS = 5 * 60_000;
/** Few-shot example cap, matching `_filter.ts`'s own `recentIcpDecisions(20)` call, doubled for the coarser rewrite task. */
const EVIDENCE_LIMIT = 40;

export async function refreshIcpProposal(): Promise<void> {
  if (demoMode()) return;
  const cfg = loadConfig();
  const currentIcp = cfg.icpOneLiner?.trim();
  // No ICP set yet: there is nothing to tighten, and the founder hasn't told
  // us who they want at all (same pass-through contract `_filter.ts` uses).
  if (!currentIcp) return;

  const ledger = getLedger();
  const minDecisions = Math.max(
    1,
    Math.floor(cfg.icpProposalMinDecisions ?? DEFAULT_ICP_PROPOSAL_MIN_DECISIONS),
  );
  // Evidence check FIRST, before taking the lease: an install with too few
  // decisions must never spend the cooldown window (or a model call) on a
  // check that was always going to come back empty.
  const decisionCount = ledger.countHumanIcpDecisions();
  if (decisionCount < minDecisions) return;

  const token = ledger.icpProposals.beginEvaluation(
    Date.now(),
    EVALUATION_COOLDOWN_MS,
    EVALUATION_LEASE_MS,
  );
  if (!token) return;

  let reservation: ReturnType<typeof tryReserveDailySpend> | undefined;
  try {
    reservation = tryReserveDailySpend(1);
    if (!reservation.granted) {
      ledger.icpProposals.fail(token, "Paused by the daily spend limit; will retry.");
      logEvent("icp_proposal.spend_capped", {}, "warn");
      return;
    }
    const examples = ledger.recentIcpDecisions(EVIDENCE_LIMIT);
    const system = loadPrompt("icp-propose-rewrite");
    const response = await complete({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            currentIcp,
            decisions: examples.map((e) => ({
              candidate: e.candidate,
              decision: e.decision,
              reason: e.reason,
            })),
          }),
        },
      ],
      temperature: 0.2,
      maxTokens: 500,
      timeoutMs: 60_000,
    });
    const parsed = tryParseJsonObject<{ proposedIcp?: unknown; evidenceSummary?: unknown }>(
      response.content,
      {},
    );
    if (typeof parsed.proposedIcp !== "string" || typeof parsed.evidenceSummary !== "string") {
      throw new Error("Invalid ICP proposal response");
    }
    const proposedIcp = parsed.proposedIcp.trim();
    const evidenceSummary = parsed.evidenceSummary.trim();
    // The model's own signal for "no clear pattern yet" (see the prompt):
    // a deliberate no-op, not a failure — the lease still releases cleanly
    // and the next eligible tick tries again with fresh evidence.
    if (!proposedIcp || !evidenceSummary) {
      ledger.icpProposals.finish(token);
      logEvent("icp_proposal.inconclusive", { decisionCount });
      return;
    }
    if (normalizeIcpText(proposedIcp) === normalizeIcpText(currentIcp)) {
      ledger.icpProposals.finish(token);
      logEvent("icp_proposal.unchanged", { decisionCount });
      return;
    }
    if (ledger.icpProposals.hasPendingDuplicate(proposedIcp)) {
      ledger.icpProposals.finish(token);
      logEvent("icp_proposal.duplicate_pending", { decisionCount });
      return;
    }
    // Dismissal is a decision, not silence: an identical rewrite must not
    // recur immediately after the founder said no to it.
    if (ledger.icpProposals.wasJustDismissed(proposedIcp)) {
      ledger.icpProposals.finish(token);
      logEvent("icp_proposal.recently_dismissed", { decisionCount });
      return;
    }
    ledger.icpProposals.insert({
      currentIcp,
      proposedIcp,
      evidenceSummary,
      createdAt: new Date().toISOString(),
    });
    ledger.icpProposals.finish(token);
    logEvent("icp_proposal.generated", { decisionCount });
  } catch {
    // Model/provider errors can contain response text; keep it out of logs and UI.
    ledger.icpProposals.fail(token, "Could not evaluate an ICP rewrite; will retry.");
    logEvent("icp_proposal.failed", {}, "warn");
  } finally {
    if (reservation?.granted) reservation.release();
  }
}
