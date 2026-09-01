import { getLedger, isDraining, logEvent } from "@oneshot-gtm/core";
import {
  getPriorStepsBulk,
  nextStepInfo,
  playFollowupCount,
  previewCadenceStep,
  previewCadenceStepBatch,
  sendCadenceStep,
  sendCadenceStepBatch,
  type BatchItem,
  type PriorStepRow,
} from "@oneshot-gtm/plays";
import type {
  CadenceCounts,
  CadenceNextStepDraft,
  CadenceStatus,
  CadenceStopReason,
  CadenceView,
  CadencesResult,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { sendsToday } from "./_capacity.ts";
import { reportServerExecution } from "../telemetry.ts";

/**
 * In-flight cadence sends are tracked on the row's `sending_started_at`
 * column (claimed atomically before the background SDK send, cleared on
 * success by `advanceCadence`, on failure in the catch) — DB-backed so it
 * survives restarts; the cold-boot sweeper recovers stranded rows. A fresh
 * Send click can reclaim a marker older than this cutoff.
 */
const MAX_SEND_AGE_MS = 5 * 60 * 1000;

/**
 * Per-play info computed once per unique play_name — avoids re-walking the
 * sequence registry + re-reading config from disk per row.
 */
interface PlayInfo {
  nextLabelByStep: Map<number, { label: string | null; isBreakup: boolean }>;
  followupCount: number;
}

function buildPlayInfoMap(
  rows: ReadonlyArray<{ play_name: string; current_step: number }>,
): Map<string, PlayInfo> {
  const map = new Map<string, PlayInfo>();
  for (const row of rows) {
    let info = map.get(row.play_name);
    if (!info) {
      info = {
        nextLabelByStep: new Map(),
        followupCount: playFollowupCount(row.play_name),
      };
      map.set(row.play_name, info);
    }
    if (!info.nextLabelByStep.has(row.current_step)) {
      const next = nextStepInfo(row.play_name, row.current_step);
      info.nextLabelByStep.set(row.current_step, {
        label: next?.label ?? null,
        isBreakup: next?.isBreakup ?? false,
      });
    }
  }
  return map;
}

function toView(
  row: ReturnType<ReturnType<typeof getLedger>["listAllCadences"]>[number],
  priorByKey: Map<string, PriorStepRow[]>,
  playInfo: Map<string, PlayInfo>,
): CadenceView {
  let nextStepDraft: CadenceNextStepDraft | null = null;
  if (row.next_step_draft_json) {
    try {
      const parsed = JSON.parse(row.next_step_draft_json) as CadenceNextStepDraft & {
        payload?: unknown;
      };
      // Strip `payload` from the wire view — only the send route reads it.
      nextStepDraft = {
        subject: parsed.subject,
        body: parsed.body,
        flags: parsed.flags ?? [],
        draftedAt: parsed.draftedAt,
      };
    } catch {
      nextStepDraft = null;
    }
  }
  const info = playInfo.get(row.play_name);
  const next = info?.nextLabelByStep.get(row.current_step) ?? null;
  const followupCount = info?.followupCount ?? 0;
  const priorSteps = (priorByKey.get(`${row.prospect_id}|${row.play_name}`) ?? []).map((s) => ({
    stepIndex: s.stepIndex,
    label: s.label,
    subject: s.subject,
    body: s.body,
    sentAt: s.sentAt,
  }));
  return {
    prospectId: row.prospect_id,
    prospectEmail: row.prospect_email,
    prospectName: row.prospect_name,
    prospectCompany: row.prospect_company,
    playName: row.play_name,
    status: row.status as CadenceStatus,
    currentStep: row.current_step,
    enrolledAt: row.enrolled_at,
    nextDueAt: row.next_due_at,
    lastPolledAt: row.last_polled_at,
    stopReason: row.stop_reason as CadenceStopReason | null,
    stopNote: row.stop_note,
    stoppedAt: row.stopped_at,
    replyChannel: row.reply_channel,
    replyAt: row.replied_at,
    nextStepDraft,
    nextStepLabel: next?.label ?? null,
    nextStepIsBreakup: next?.isBreakup ?? false,
    followupCount,
    priorSteps,
    isSending: row.sending_started_at != null,
    lastSendError: row.last_send_error,
    lastSendErrorAt: row.last_send_error_at,
  };
}

function viewsForRows(
  rows: ReadonlyArray<ReturnType<ReturnType<typeof getLedger>["listAllCadences"]>[number]>,
): CadenceView[] {
  // Single SQL fetch for ALL (prospect_id, play_name) pairs — avoids N+1.
  const pairs = rows.map((r) => ({ prospectId: r.prospect_id, playName: r.play_name }));
  const priorByKey = getPriorStepsBulk(pairs);
  const playInfo = buildPlayInfoMap(rows);
  return rows.map((r) => toView(r, priorByKey, playInfo));
}

export function listCadences(req: Request): Response {
  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  // Optional `?sinceRun=N` — the /run → /cadences deep-link; filters to run
  // N's prospect set. Malformed run ids fall back to all-cadences.
  const sinceRunRaw = url.searchParams.get("sinceRun");
  const sinceRunId =
    sinceRunRaw && Number.isFinite(Number.parseInt(sinceRunRaw, 10))
      ? Number.parseInt(sinceRunRaw, 10)
      : null;
  const ledger = getLedger();
  // The active/all toggle only narrows the TABLE; the summary tiles must
  // reflect every status (else REPLIED reads 0 under the default filter).
  const allRows = ledger.listAllCadences();
  let countRows = allRows;
  let rows = all ? allRows : allRows.filter((r) => r.status === "active");
  if (sinceRunId != null) {
    const run = ledger.getRun(sinceRunId);
    // Unknown runId → zero rows (clearer than silently ignoring the filter).
    const wantedEmails = new Set(
      (run?.prospectEmails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
    );
    const inRun = (r: { prospect_email: string | null }): boolean => {
      const email = r.prospect_email?.trim().toLowerCase();
      return email != null && wantedEmails.has(email);
    };
    rows = rows.filter(inRun);
    // Scope the tiles to the run too, so they describe the same filtered view.
    countRows = countRows.filter(inRun);
  }
  const body: CadencesResult = { cadences: viewsForRows(rows), counts: tallyCounts(countRows) };
  const capacity = sendsToday();
  if (capacity) body.sendsToday = capacity;
  return jsonResponse(body, 200, req);
}

/** Status breakdown for the summary tiles — `overdue` = active & past due. */
function tallyCounts(
  rows: ReadonlyArray<{ status: string; next_due_at: string | null }>,
): CadenceCounts {
  const now = Date.now();
  const counts: CadenceCounts = {
    active: 0,
    replied: 0,
    breakup: 0,
    completed: 0,
    paused: 0,
    stopped: 0,
    bounced: 0,
    overdue: 0,
  };
  for (const r of rows) {
    if (
      r.status === "active" ||
      r.status === "replied" ||
      r.status === "breakup" ||
      r.status === "completed" ||
      r.status === "paused" ||
      r.status === "stopped" ||
      r.status === "bounced"
    ) {
      counts[r.status]++;
      if (r.status === "active" && r.next_due_at && new Date(r.next_due_at).getTime() <= now) {
        counts.overdue++;
      }
    }
  }
  return counts;
}

export function getCadence(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const all = ledger.listCadencesForProspect(id);
  if (all.length === 0) return jsonResponse({ error: "no cadences for prospect" }, 404, req);
  return jsonResponse({ cadences: viewsForRows(all) }, 200, req);
}

const STOP_REASONS = new Set<CadenceStopReason>([
  "bad_timing",
  "other",
  "not_a_fit",
  "do_not_contact",
]);

export async function stopCadence(req: Request, params: Record<string, string>): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const url = new URL(req.url);
  const playName = url.searchParams.get("play");
  if (!playName) return jsonResponse({ error: "play query param required" }, 400, req);
  let body: { reason?: unknown; note?: unknown } = {};
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ error: "JSON object body required" }, 400, req);
    }
    body = parsed as { reason?: unknown; note?: unknown };
  } catch {
    return jsonResponse({ error: "JSON body required" }, 400, req);
  }
  if (typeof body.reason !== "string" || !STOP_REASONS.has(body.reason as CadenceStopReason)) {
    return jsonResponse({ error: "valid stop reason required" }, 400, req);
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (body.reason === "other" && !note) {
    return jsonResponse({ error: "note required for other" }, 400, req);
  }
  if (note.length > 500)
    return jsonResponse({ error: "note must be 500 characters or less" }, 400, req);
  const ledger = getLedger();
  const cadence = ledger.getCadence(id, playName);
  if (!cadence) return jsonResponse({ error: "cadence not found" }, 404, req);
  if (cadence.status !== "active") {
    return jsonResponse({ error: `cadence is already ${cadence.status}` }, 409, req);
  }
  if (cadence.sending_started_at) {
    return jsonResponse(
      { error: "cadence send is already in flight; wait for it to finish" },
      409,
      req,
    );
  }
  const stopped = ledger.stopCadence({
    prospectId: id,
    playName,
    reason: body.reason as CadenceStopReason,
    ...(note ? { note } : {}),
  });
  if (!stopped)
    return jsonResponse({ error: "cadence changed while stopping; refresh and retry" }, 409, req);
  return jsonResponse({ stopped: stopped ? 1 : 0 }, 200, req);
}

function parseProspectAndPlay(
  req: Request,
  params: Record<string, string>,
): { prospectId: number; playName: string } | Response {
  const prospectId = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(prospectId)) return jsonResponse({ error: "bad id" }, 400, req);
  const url = new URL(req.url);
  const playName = url.searchParams.get("play") ?? "";
  if (!playName) return jsonResponse({ error: "play query param required" }, 400, req);
  return { prospectId, playName };
}

export async function previewCadenceStepRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const parsed = parseProspectAndPlay(req, params);
  if (parsed instanceof Response) return parsed;
  try {
    const preview = await previewCadenceStep(parsed);
    return jsonResponse(
      {
        subject: preview.subject,
        body: preview.body,
        flags: preview.flags,
        draftedAt: preview.draftedAt,
        stepLabel: preview.stepLabel,
        isBreakup: preview.isBreakup,
      },
      200,
      req,
    );
  } catch (err) {
    const msg = (err as Error).message ?? "preview failed";
    const status = msg.startsWith("no cadence") || msg.startsWith("cadence is") ? 409 : 500;
    return jsonResponse({ error: msg }, status, req);
  }
}

export async function sendCadenceStepRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (isDraining()) {
    return jsonResponse({ error: "server restarting — retry in a moment" }, 503, req);
  }
  const parsed = parseProspectAndPlay(req, params);
  if (parsed instanceof Response) return parsed;
  // 409 synchronously when no persisted draft exists, but the actual send is
  // fire-and-forget — an SDK send takes ~2 min and must not block the modal.
  const ledger = getLedger();
  try {
    const draft = ledger.getCadenceDraft(parsed);
    if (!draft) {
      return jsonResponse({ error: "no persisted preview — click Preview first" }, 409, req);
    }
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "send failed" }, 500, req);
  }
  // Atomic claim — survives restart; `staleCutoffIso` lets a fresh click
  // reclaim a stranded marker without waiting for the cold-boot sweep.
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - MAX_SEND_AGE_MS).toISOString();
  const claimed = ledger.claimCadenceSendingMarker({
    prospectId: parsed.prospectId,
    playName: parsed.playName,
    startedAtIso: nowIso,
    staleCutoffIso,
  });
  if (!claimed) {
    return jsonResponse(
      { error: "already sending — wait for the in-flight send to complete" },
      409,
      req,
    );
  }
  const sendStartedAt = performance.now();
  void (async () => {
    try {
      await sendCadenceStep(parsed);
      // advanceCadence already cleared sending_started_at in its UPDATE.
      void reportServerExecution("server.cadence.send", {
        outcome: "ok",
        durationMs: performance.now() - sendStartedAt,
      });
    } catch (err) {
      void reportServerExecution("server.cadence.send", {
        outcome: "error",
        durationMs: performance.now() - sendStartedAt,
      });
      logEvent(
        "cadence.send.failed",
        {
          prospect_id: parsed.prospectId,
          play_name: parsed.playName,
          message_120: ((err as Error)?.message ?? "").slice(0, 120),
        },
        "error",
      );
      // advanceCadence never ran — release the stuck marker for a re-Send.
      try {
        ledger.clearCadenceSendingMarker(parsed);
      } catch {
        // sweeper safety net
      }
    }
  })();
  return jsonResponse({ accepted: true }, 202, req);
}

async function parseBatchItems(req: Request): Promise<BatchItem[] | Response> {
  let body: { items?: unknown };
  try {
    body = (await req.json()) as { items?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!Array.isArray(body.items)) {
    return jsonResponse({ error: "items: array required" }, 400, req);
  }
  const items: BatchItem[] = [];
  for (const raw of body.items) {
    if (raw && typeof raw === "object" && "prospectId" in raw && "playName" in raw) {
      const it = raw as { prospectId: unknown; playName: unknown };
      if (typeof it.prospectId === "number" && typeof it.playName === "string") {
        items.push({ prospectId: it.prospectId, playName: it.playName });
      }
    }
  }
  if (items.length === 0) {
    return jsonResponse({ error: "no valid items in body" }, 400, req);
  }
  return items;
}

export async function previewCadenceBatchRoute(req: Request): Promise<Response> {
  const itemsOrErr = await parseBatchItems(req);
  if (itemsOrErr instanceof Response) return itemsOrErr;
  const results = await previewCadenceStepBatch(itemsOrErr);
  return jsonResponse({ results }, 200, req);
}

export async function sendCadenceBatchRoute(req: Request): Promise<Response> {
  if (isDraining()) {
    return jsonResponse({ error: "server restarting — retry in a moment" }, 503, req);
  }
  const itemsOrErr = await parseBatchItems(req);
  if (itemsOrErr instanceof Response) return itemsOrErr;
  const items = itemsOrErr;
  // Claim each row's marker atomically; unclaimable rows (already sending)
  // are dropped, so `accepted` reflects the actual attempt count.
  const ledger = getLedger();
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - MAX_SEND_AGE_MS).toISOString();
  const claimed: BatchItem[] = [];
  for (const item of items) {
    const ok = ledger.claimCadenceSendingMarker({
      prospectId: item.prospectId,
      playName: item.playName,
      startedAtIso: nowIso,
      staleCutoffIso,
    });
    if (ok) claimed.push(item);
  }
  if (claimed.length === 0) {
    return jsonResponse(
      { error: "no claimable rows — all selected are already sending" },
      409,
      req,
    );
  }
  const batchStartedAt = performance.now();
  void (async () => {
    try {
      // Per-item marker clear — success already clears via advanceCadence,
      // so this catches the failure path only; the clear is idempotent.
      await sendCadenceStepBatch(claimed, (item) => {
        try {
          ledger.clearCadenceSendingMarker(item);
        } catch {
          /* sweeper safety net */
        }
      });
      void reportServerExecution("server.cadence.batch", {
        outcome: "ok",
        durationMs: performance.now() - batchStartedAt,
      });
    } catch (err) {
      void reportServerExecution("server.cadence.batch", {
        outcome: "error",
        durationMs: performance.now() - batchStartedAt,
      });
      // Only fires if the wrapper itself throws — release every marker so a
      // retry needn't wait for the sweep.
      for (const item of claimed) {
        try {
          ledger.clearCadenceSendingMarker(item);
        } catch {
          /* ignore */
        }
      }
      logEvent(
        "cadence.batch.failed",
        { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
        "error",
      );
    }
  })();
  return jsonResponse({ accepted: claimed.length }, 202, req);
}
