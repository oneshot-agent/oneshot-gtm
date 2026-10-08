import {
  demoMode,
  getLedger,
  decideLearning,
  LearningDecisionError,
  recoverLearningApplications,
} from "@oneshot-gtm/core";
import type {
  LearningDecisionResult,
  LearningGuidanceResult,
  LearningKind,
  LearningProposalStatus,
  LearningProposalsResult,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * Unified learning review (issue #813). One list and one decision path for
 * every learned change: a writing preference, a prospect's angle, a play's
 * configured angle set, the ICP one-liner. Approval is the only way any of
 * them reaches a draft, and it changes only drafts written afterwards —
 * nothing here rewrites or sends an existing draft.
 *
 * Each kind has an `apply` (write the approved value where the active value
 * lives) and a `revert` (put the proposal's `current` snapshot back), both
 * behind a baseline check: the proposal was computed against the value
 * active when it was generated, so if that value has since moved (a /setup
 * edit, another approval) the approval is refused with 409 rather than
 * silently discarding the newer decision. The order mirrors the #750 ICP
 * route: check → decide → apply → mark applied → mark siblings stale, and a
 * failed apply reverts the decision so the store never records an approval
 * that did not take effect.
 */

const KINDS: ReadonlyArray<LearningKind> = [
  "preference",
  "prospect_angle",
  "campaign_angle",
  "icp",
];
const STATUSES: ReadonlyArray<LearningProposalStatus> = [
  "pending",
  "approved",
  "dismissed",
  "stale",
  "rolled_back",
];
const READ_ONLY = { error: "The demo is read-only." };

function parseKind(v: string | null): LearningKind | undefined {
  return v && (KINDS as ReadonlyArray<string>).includes(v) ? (v as LearningKind) : undefined;
}

/** GET /api/learning/proposals?kind&status&prospectId&playName&limit — `status` defaults to pending; `all` for history. */
export function listLearningProposalsRoute(req: Request): Response {
  recoverLearningApplications(getLedger());
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "all"
      ? "all"
      : statusParam && (STATUSES as ReadonlyArray<string>).includes(statusParam)
        ? (statusParam as LearningProposalStatus)
        : "pending";
  const prospectId = Number.parseInt(url.searchParams.get("prospectId") ?? "", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const body: LearningProposalsResult = {
    proposals: getLedger().learning.list({
      kind: parseKind(url.searchParams.get("kind")),
      status,
      ...(Number.isFinite(prospectId) ? { prospectId } : {}),
      ...(url.searchParams.get("playName") ? { playName: url.searchParams.get("playName")! } : {}),
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200,
    }),
  };
  return jsonResponse(body, 200, req);
}

/**
 * POST /api/learning/proposals/:id/approve, body `{ value? }` for an
 * edit-and-approve. 409 on an unknown id, a decided proposal, or a moved
 * baseline; 500 (and the decision reverted) when applying failed.
 */
export async function approveLearningProposalRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  let body: { value?: unknown } = {};
  try {
    body = (await req.json()) as { value?: unknown };
  } catch {
    /* approve as proposed */
  }
  return decisionResponse(req, params, "approve", body?.value);
}

function decisionResponse(
  req: Request,
  params: Record<string, string>,
  action: "approve" | "dismiss" | "rollback",
  value?: unknown,
): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  try {
    const proposal = decideLearning(getLedger(), params["id"] ?? "", action, value);
    return jsonResponse({ ok: true, proposal } satisfies LearningDecisionResult, 200, req);
  } catch (e) {
    return jsonResponse(
      { error: (e as Error).message },
      e instanceof LearningDecisionError ? e.status : 500,
      req,
    );
  }
}

export function dismissLearningProposalRoute(
  req: Request,
  params: Record<string, string>,
): Response {
  return decisionResponse(req, params, "dismiss");
}
export function rollbackLearningProposalRoute(
  req: Request,
  params: Record<string, string>,
): Response {
  return decisionResponse(req, params, "rollback");
}

/** GET /api/learning/guidance — every approved preference, enabled or not, with the current guidance version. */
export function listLearningGuidanceRoute(req: Request): Response {
  const learning = getLedger().learning;
  const body: LearningGuidanceResult = {
    version: learning.guidanceVersion(),
    guidance: learning.listGuidance(true),
  };
  return jsonResponse(body, 200, req);
}

/** POST /api/learning/guidance/:id, body `{ enabled }`. */
export async function setLearningGuidanceRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  let body: { enabled?: unknown } = {};
  try {
    body = (await req.json()) as { enabled?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof body.enabled !== "boolean")
    return jsonResponse({ error: "enabled (boolean) required" }, 400, req);
  try {
    getLedger().learning.setGuidanceEnabled(params["id"] ?? "", body.enabled);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 409, req);
  }
  return jsonResponse({ ok: true }, 200, req);
}

/** POST /api/learning/guidance/:id/rollback — the preference stops applying for good. */
export function rollbackLearningGuidanceRoute(
  req: Request,
  params: Record<string, string>,
): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  const ledger = getLedger();
  const id = params["id"] ?? "";
  const row = ledger.learning.getGuidance(id);
  if (!row) return jsonResponse({ error: "Learned preference not found" }, 409, req);
  return ledger.transaction(() => {
    if (!ledger.learning.rollbackGuidance(id))
      return jsonResponse({ error: "Learned preference was already rolled back" }, 409, req);
    if (row.proposalId) ledger.learning.rollback(row.proposalId, new Date().toISOString());
    return jsonResponse({ ok: true }, 200, req);
  });
}
