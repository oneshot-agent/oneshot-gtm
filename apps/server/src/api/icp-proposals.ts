import { getLedger, loadConfig, logEvent, saveConfig } from "@oneshot-gtm/core";
import type { IcpProposalDecisionResult, IcpProposalsResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * GET /api/icp-proposals. Learning-loop v2 (issue #750): `/queue` displays
 * pending proposals here. Query `?status=` narrows to one status; omitted
 * defaults to `pending` (the surface this route exists for), matching the
 * founder's mental model of "what needs my decision right now". Pass
 * `status=all` to see the full history (approved + dismissed) for context.
 */
export function listIcpProposalsRoute(req: Request): Response {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const ledger = getLedger();
  const proposals =
    statusParam === "all"
      ? ledger.icpProposals.list()
      : ledger.icpProposals.list(
          statusParam === "approved" || statusParam === "dismissed" ? statusParam : "pending",
        );
  const body: IcpProposalsResult = { proposals };
  return jsonResponse(body, 200, req);
}

/**
 * POST /api/icp-proposals/:id/approve. Atomically updates the active ICP and
 * records the decision: the proposal flips to `approved` first (under
 * SQLite's write lock, so a concurrent double-click can't approve twice),
 * then config.json is saved. If saving config fails, the decision is
 * reverted to `pending` so the store's own state and the actually-active ICP
 * never disagree about whether this approval took effect.
 */
export function approveIcpProposalRoute(req: Request, params: Record<string, string>): Response {
  const id = params["id"] ?? "";
  const ledger = getLedger();
  const now = new Date().toISOString();
  const decided = ledger.icpProposals.decide(id, "approved", now);
  if ("error" in decided) return jsonResponse({ error: decided.error }, 409, req);
  try {
    const cfg = loadConfig();
    saveConfig({ ...cfg, icpOneLiner: decided.view.proposedIcp });
  } catch (err) {
    ledger.icpProposals.revertToPending(id);
    logEvent(
      "icp_proposal.approve_config_write_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    return jsonResponse({ error: "could not update the active ICP; try again" }, 500, req);
  }
  const body: IcpProposalDecisionResult = { ok: true, icpOneLiner: decided.view.proposedIcp };
  return jsonResponse(body, 200, req);
}

/**
 * POST /api/icp-proposals/:id/dismiss. Leaves the active ICP untouched; the
 * generator (`icp-proposals.ts`'s `wasJustDismissed`) refuses to re-propose
 * this exact text on the very next tick, so dismissing doesn't just re-appear
 * a moment later.
 */
export function dismissIcpProposalRoute(req: Request, params: Record<string, string>): Response {
  const id = params["id"] ?? "";
  const ledger = getLedger();
  const decided = ledger.icpProposals.decide(id, "dismissed", new Date().toISOString());
  if ("error" in decided) return jsonResponse({ error: decided.error }, 409, req);
  const body: IcpProposalDecisionResult = { ok: true };
  return jsonResponse(body, 200, req);
}
