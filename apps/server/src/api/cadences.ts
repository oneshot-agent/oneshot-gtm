import { getLedger, logEvent } from "@oneshot-gtm/core";
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
import type { CadenceNextStepDraft, CadenceStatus, CadenceView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * In-process tracker of cadence steps that have a fire-and-forget send in
 * flight. Populated by sendCadenceStepRoute + sendCadenceBatchRoute when
 * they kick off the background SDK send (~2 min per row), cleared per-row
 * as each send settles. Used by `toView` to surface `isSending: true` so
 * /cadences can visually mark in-flight rows AND gate them out of the
 * sendable-rows count. Lost on server restart (acceptable — in-flight SDK
 * calls die with the process anyway).
 */
const inFlightSends = new Set<string>();
const inFlightKey = (prospectId: number, playName: string): string => `${prospectId}|${playName}`;

/**
 * Per-play info that doesn't change between rows of the same play. Computed
 * once per unique play_name and reused for every row to avoid re-walking the
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
      // Strip `payload` from the wire view — internal envelope only the
      // send route reads. UI only needs subject/body/flags/draftedAt.
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
    nextStepDraft,
    nextStepLabel: next?.label ?? null,
    nextStepIsBreakup: next?.isBreakup ?? false,
    followupCount,
    priorSteps,
    isSending: inFlightSends.has(inFlightKey(row.prospect_id, row.play_name)),
  };
}

function viewsForRows(
  rows: ReadonlyArray<ReturnType<ReturnType<typeof getLedger>["listAllCadences"]>[number]>,
): CadenceView[] {
  // Single SQL fetch for ALL (prospect_id, play_name) pairs — replaces the
  // N+1 of one listSequenceEventsForProspectPlay per row.
  const pairs = rows.map((r) => ({ prospectId: r.prospect_id, playName: r.play_name }));
  const priorByKey = getPriorStepsBulk(pairs);
  // Compute play-level info (nextStepInfo + playFollowupCount) once per
  // unique play_name — each calls effectiveSequence → loadConfig (readFileSync).
  const playInfo = buildPlayInfoMap(rows);
  return rows.map((r) => toView(r, priorByKey, playInfo));
}

export function listCadences(req: Request): Response {
  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  const ledger = getLedger();
  const rows = all ? ledger.listAllCadences() : ledger.listActiveCadences();
  return jsonResponse({ cadences: viewsForRows(rows) }, 200, req);
}

export function getCadence(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const all = ledger.listCadencesForProspect(id);
  if (all.length === 0) return jsonResponse({ error: "no cadences for prospect" }, 404, req);
  return jsonResponse({ cadences: viewsForRows(all) }, 200, req);
}

export function stopCadence(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const url = new URL(req.url);
  const playName = url.searchParams.get("play");
  const ledger = getLedger();
  const cadences = ledger.listCadencesForProspect(id).filter((c) => {
    if (playName && c.play_name !== playName) return false;
    return c.status === "active";
  });
  for (const cad of cadences) {
    ledger.setCadenceStatus({
      prospectId: id,
      playName: cad.play_name,
      status: "completed",
    });
  }
  return jsonResponse({ stopped: cadences.length }, 200, req);
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
  const parsed = parseProspectAndPlay(req, params);
  if (parsed instanceof Response) return parsed;
  // Verify the preview exists synchronously so we can 409 the founder
  // immediately if they clicked Send without a persisted draft — but the
  // actual send is fire-and-forget. SDK email send takes ~2 min; blocking
  // the modal that long is bad UX, especially since the founder already
  // approved by confirming. Mirrors POST /api/cadences/send-batch.
  try {
    const draft = getLedger().getCadenceDraft(parsed);
    if (!draft) {
      return jsonResponse({ error: "no persisted preview — click Preview first" }, 409, req);
    }
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "send failed" }, 500, req);
  }
  const key = inFlightKey(parsed.prospectId, parsed.playName);
  inFlightSends.add(key);
  void (async () => {
    try {
      await sendCadenceStep(parsed);
    } catch (err) {
      logEvent(
        "cadence.send.failed",
        {
          prospect_id: parsed.prospectId,
          play_name: parsed.playName,
          message_120: ((err as Error)?.message ?? "").slice(0, 120),
        },
        "error",
      );
    } finally {
      inFlightSends.delete(key);
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
  const itemsOrErr = await parseBatchItems(req);
  if (itemsOrErr instanceof Response) return itemsOrErr;
  const items = itemsOrErr;
  // Add all selected rows to the in-flight set up front. Per-item callback
  // clears each as the batch wrapper finishes that row, so the UI marks
  // them as "sending" only for the actual SDK-call window — not the entire
  // batch duration.
  for (const item of items) inFlightSends.add(inFlightKey(item.prospectId, item.playName));
  void (async () => {
    try {
      await sendCadenceStepBatch(items, (item) => {
        inFlightSends.delete(inFlightKey(item.prospectId, item.playName));
      });
    } catch (err) {
      // Belt-and-suspenders: the wrapper catches per-item; this catch only
      // fires if the wrapper itself throws (shouldn't, but defense in depth).
      for (const item of items) inFlightSends.delete(inFlightKey(item.prospectId, item.playName));
      logEvent(
        "cadence.batch.failed",
        { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
        "error",
      );
    }
  })();
  return jsonResponse({ accepted: items.length }, 202, req);
}
