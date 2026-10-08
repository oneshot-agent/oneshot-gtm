import {
  demoMode,
  getLedger,
  learningKeyOf,
  learningScopeKey,
  loadConfig,
  logEvent,
  normalizeIcpText,
  saveConfig,
  type Ledger,
} from "@oneshot-gtm/core";
import type {
  LearningDecisionResult,
  LearningGuidanceResult,
  LearningKind,
  LearningProposalStatus,
  LearningProposalView,
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

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asText = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);

interface KindHandler {
  /** The active value's fingerprint right now, compared with the proposal's `baselineKey`. */
  baselineKey(ledger: Ledger, p: LearningProposalView): string | null;
  /** Shape-check and normalize an edited value; null means "approve as proposed". */
  edited(p: LearningProposalView, value: unknown): { value: unknown } | { error: string };
  apply(ledger: Ledger, p: LearningProposalView, value: unknown, now: string): void;
  revert(ledger: Ledger, p: LearningProposalView, now: string): void;
}

/** Campaign angles live in one field of the trigger's config_json (`yourEdge`, or `yourClaim` for hiring-signal). */
function triggerEdge(
  ledger: Ledger,
  playName: string,
): { config: Record<string, unknown>; field: string; edge: string } | null {
  const row = ledger.getTrigger(playName);
  if (!row) return null;
  let config: Record<string, unknown> = {};
  try {
    config = asRecord(JSON.parse(row.config_json ?? "{}")) ?? {};
  } catch {
    config = {};
  }
  const field =
    typeof config["yourClaim"] === "string" && !config["yourEdge"] ? "yourClaim" : "yourEdge";
  return {
    config,
    field,
    edge: typeof config[field] === "string" ? (config[field] as string) : "",
  };
}

const HANDLERS: Record<LearningKind, KindHandler> = {
  icp: {
    baselineKey: () => normalizeIcpText(loadConfig().icpOneLiner ?? ""),
    edited: (_p, value) => {
      const text = asText(value);
      if (!text) return { error: "an edited ICP must be a non-empty string" };
      if (text.length > 1000) return { error: "an ICP one-liner is at most 1000 characters" };
      return { value: text };
    },
    apply: (_ledger, _p, value) => {
      saveConfig({ ...loadConfig(), icpOneLiner: value as string });
    },
    revert: (_ledger, p) => {
      saveConfig({ ...loadConfig(), icpOneLiner: asText(p.current) ?? null });
    },
  },
  prospect_angle: {
    baselineKey: (ledger, p) => {
      const id = p.scope.prospectId;
      if (id == null) return null;
      const prospect = ledger.getProspectById(id);
      if (!prospect) return null;
      return learningKeyOf(prospect.angle_json ?? "");
    },
    edited: (p, value) => {
      const edit = asRecord(value);
      const base = asRecord(p.proposed);
      if (!edit || !base) return { error: "an edited angle must be an object" };
      const merged = { ...base, ...edit };
      if (!asText(merged["hook"])) return { error: "an angle needs a non-empty hook" };
      return { value: merged };
    },
    apply: (ledger, p, value, now) => {
      const id = p.scope.prospectId!;
      if (!ledger.getProspectById(id)) throw new Error(`prospect #${id} not found`);
      ledger.setProspectAngle(id, JSON.stringify(value), { approvedAt: now });
    },
    revert: (ledger, p) => {
      const id = p.scope.prospectId!;
      const before = asRecord(p.current);
      const angleJson =
        before && typeof before["angleJson"] === "string" ? before["angleJson"] : null;
      const approvedAt =
        before && typeof before["approvedAt"] === "string" ? before["approvedAt"] : null;
      ledger.setProspectAngle(id, angleJson, { approvedAt });
    },
  },
  campaign_angle: {
    baselineKey: (ledger, p) => {
      if (!p.scope.playName) return null;
      const t = triggerEdge(ledger, p.scope.playName);
      return t ? learningKeyOf(t.edge) : null;
    },
    edited: (p, value) => {
      const edit = asRecord(value);
      const base = asRecord(p.proposed);
      const edge = asText(edit?.["edge"] ?? value);
      if (!edge) return { error: "an edited angle set must be a non-empty `edge` string" };
      return { value: { ...base, edge } };
    },
    apply: (ledger, p, value) => {
      const t = triggerEdge(ledger, p.scope.playName!);
      if (!t) throw new Error(`trigger '${p.scope.playName}' not found`);
      const edge = asText(asRecord(value)?.["edge"]) ?? "";
      ledger.setTriggerConfig(p.scope.playName!, JSON.stringify({ ...t.config, [t.field]: edge }));
    },
    revert: (ledger, p) => {
      const t = triggerEdge(ledger, p.scope.playName!);
      if (!t) throw new Error(`trigger '${p.scope.playName}' not found`);
      const edge = asText(asRecord(p.current)?.["edge"]) ?? "";
      ledger.setTriggerConfig(p.scope.playName!, JSON.stringify({ ...t.config, [t.field]: edge }));
    },
  },
  preference: {
    // Guidance only ever accumulates: there is no single active value to drift.
    baselineKey: () => "",
    edited: (p, value) => {
      const base = asRecord(p.proposed);
      const instruction = asText(asRecord(value)?.["instruction"] ?? value);
      if (!instruction) return { error: "an edited preference must be a non-empty instruction" };
      if (instruction.length > 500) return { error: "a preference is at most 500 characters" };
      return { value: { ...base, instruction } };
    },
    apply: (ledger, p, value, now) => {
      const v = asRecord(value) ?? {};
      const source = v["source"];
      ledger.learning.addGuidance({
        instruction: asText(v["instruction"]) ?? "",
        source: source === "explicit" || source === "edits" ? source : "style",
        channel: p.scope.channel ?? null,
        stage: p.scope.stage ?? null,
        proposalId: p.id,
        evidence: p.evidence,
        now,
      });
    },
    revert: (ledger, p, now) => {
      for (const g of ledger.learning.listGuidance(true))
        if (g.proposalId === p.id) ledger.learning.rollbackGuidance(g.id, now);
    },
  },
};

function parseKind(v: string | null): LearningKind | undefined {
  return v && (KINDS as ReadonlyArray<string>).includes(v) ? (v as LearningKind) : undefined;
}

/** GET /api/learning/proposals?kind&status&prospectId&playName&limit — `status` defaults to pending; `all` for history. */
export function listLearningProposalsRoute(req: Request): Response {
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
  const id = params["id"] ?? "";
  const ledger = getLedger();
  const existing = ledger.learning.get(id);
  if (!existing) return jsonResponse({ error: `proposal '${id}' not found` }, 409, req);
  if (existing.status !== "pending")
    return jsonResponse({ error: `proposal '${id}' was already ${existing.status}` }, 409, req);
  let body: { value?: unknown } = {};
  try {
    body = (await req.json()) as { value?: unknown };
  } catch {
    // no body: approve as proposed
  }
  const handler = HANDLERS[existing.kind];
  const baseline = handler.baselineKey(ledger, existing);
  if (baseline === null)
    return jsonResponse(
      { error: "what this proposal would change no longer exists; dismiss it" },
      409,
      req,
    );
  if (baseline !== existing.baselineKey)
    return jsonResponse(
      {
        error:
          "the active value has changed since this proposal was generated; dismiss it and wait for a fresh one",
      },
      409,
      req,
    );
  let value: unknown = existing.proposed;
  let decided: unknown;
  if (body.value !== undefined && body.value !== null) {
    const edited = handler.edited(existing, body.value);
    if ("error" in edited) return jsonResponse({ error: edited.error }, 400, req);
    value = edited.value;
    decided = edited.value;
  }
  const now = new Date().toISOString();
  const result = ledger.learning.decide(id, "approved", now, decided);
  if ("error" in result) return jsonResponse({ error: result.error }, 409, req);
  try {
    handler.apply(ledger, existing, value, now);
  } catch (err) {
    ledger.learning.revertToPending(id);
    logEvent(
      "learning.approve_apply_failed",
      { kind: existing.kind, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    return jsonResponse({ error: "could not apply the approved change; try again" }, 500, req);
  }
  ledger.learning.markApplied(id, now);
  // Preferences accumulate; every other kind replaces one active value, so
  // its pending siblings were computed against a baseline that just moved.
  if (existing.kind !== "preference")
    ledger.learning.markStale(
      existing.kind,
      learningScopeKey(existing.kind, existing.scope),
      now,
      id,
    );
  logEvent("learning.approved", { kind: existing.kind, edited: decided !== undefined });
  const out: LearningDecisionResult = { ok: true, proposal: ledger.learning.get(id)! };
  return jsonResponse(out, 200, req);
}

/** POST /api/learning/proposals/:id/dismiss — nothing changes; the generator will not re-propose this text next tick. */
export function dismissLearningProposalRoute(
  req: Request,
  params: Record<string, string>,
): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  const id = params["id"] ?? "";
  const result = getLedger().learning.decide(id, "dismissed", new Date().toISOString());
  if ("error" in result) return jsonResponse({ error: result.error }, 409, req);
  const out: LearningDecisionResult = { ok: true, proposal: result.view };
  return jsonResponse(out, 200, req);
}

/**
 * POST /api/learning/proposals/:id/rollback — restore the proposal's
 * `current` snapshot. Existing drafts are untouched; only drafts written
 * from now on see the restored value.
 */
export function rollbackLearningProposalRoute(
  req: Request,
  params: Record<string, string>,
): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  const id = params["id"] ?? "";
  const ledger = getLedger();
  const existing = ledger.learning.get(id);
  if (!existing) return jsonResponse({ error: `proposal '${id}' not found` }, 409, req);
  const now = new Date().toISOString();
  const result = ledger.learning.rollback(id, now);
  if ("error" in result) return jsonResponse({ error: result.error }, 409, req);
  try {
    HANDLERS[existing.kind].revert(ledger, existing, now);
  } catch (err) {
    logEvent(
      "learning.rollback_revert_failed",
      { kind: existing.kind, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    return jsonResponse(
      { error: "the proposal is marked rolled back but the previous value could not be restored" },
      500,
      req,
    );
  }
  logEvent("learning.rolled_back", { kind: existing.kind });
  const out: LearningDecisionResult = { ok: true, proposal: result.view };
  return jsonResponse(out, 200, req);
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
  if (!ledger.learning.rollbackGuidance(id))
    return jsonResponse({ error: "Learned preference was already rolled back" }, 409, req);
  if (row.proposalId) ledger.learning.rollback(row.proposalId, new Date().toISOString());
  return jsonResponse({ ok: true }, 200, req);
}
