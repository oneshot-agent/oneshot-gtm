import {
  getLedger,
  loadConfig,
  demoMode,
  decideLearning,
  LearningDecisionError,
} from "@oneshot-gtm/core";
import type { IcpProposalsResult } from "@oneshot-gtm/shared-types";
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

/** Compatibility endpoints use the same decision service and demo guard. */
export function approveIcpProposalRoute(req: Request, params: Record<string, string>): Response {
  return decide(req, params, "approve");
}
export function dismissIcpProposalRoute(req: Request, params: Record<string, string>): Response {
  return decide(req, params, "dismiss");
}
function decide(
  req: Request,
  params: Record<string, string>,
  action: "approve" | "dismiss",
): Response {
  if (demoMode()) return jsonResponse({ error: "The demo is read-only." }, 403, req);
  const ledger = getLedger();
  const id = params["id"] ?? "";
  if (ledger.learning.get(id)?.kind !== "icp")
    return jsonResponse({ error: "ICP proposal not found" }, 409, req);
  try {
    decideLearning(ledger, id, action);
    return jsonResponse(
      { ok: true, ...(action === "approve" ? { icpOneLiner: loadConfig().icpOneLiner } : {}) },
      200,
      req,
    );
  } catch (e) {
    return jsonResponse(
      { error: (e as Error).message },
      e instanceof LearningDecisionError ? e.status : 500,
      req,
    );
  }
}
