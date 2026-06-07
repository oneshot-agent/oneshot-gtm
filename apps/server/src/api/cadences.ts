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
import type { CadenceNextStepDraft, CadenceStatus, CadenceView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * In-flight cadence sends are tracked on the cadence_state row's
 * `sending_started_at` column (claimed atomically by
 * `ledger.claimCadenceSendingMarker` before the background SDK send fires,
 * cleared on success via `advanceCadence` and on failure in the catch).
 *
 * History: this used to be an in-memory Set. Under `bun --watch` a file save
 * killed the background promise mid-SDK-call, leaving the founder with no
 * "sending" UI signal AND no email delivered. The DB-backed marker survives
 * restarts; the cold-boot sweeper recovers stranded rows.
 *
 * Stale-cutoff window: a fresh Send click can reclaim a marker older than
 * this. Set to MAX_SEND_AGE_MS to match the cold-boot sweeper threshold —
 * the only way the marker is older is if a previous send was killed.
 */
const MAX_SEND_AGE_MS = 5 * 60 * 1000;

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
    isSending: row.sending_started_at != null,
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
  // Optional `?sinceRun=N` filter — the /run-page → /cadences deep-link from
  // run-complete mode. Resolves `runs.prospect_emails_json` for run N and
  // filters cadences to that prospect set (matched by canonicalized email).
  // Falls back to all-cadences when the run id is malformed or unknown.
  const sinceRunRaw = url.searchParams.get("sinceRun");
  const sinceRunId =
    sinceRunRaw && Number.isFinite(Number.parseInt(sinceRunRaw, 10))
      ? Number.parseInt(sinceRunRaw, 10)
      : null;
  const ledger = getLedger();
  let rows = all ? ledger.listAllCadences() : ledger.listActiveCadences();
  if (sinceRunId != null) {
    const run = ledger.getRun(sinceRunId);
    // Unknown runId → return zero rows. The UI shows "0 cadences filtered to
    // run #N" with a [clear filter] CTA, which is clearer than silently
    // ignoring the filter and showing everything.
    const wantedEmails = new Set(
      (run?.prospectEmails ?? [])
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    );
    rows = rows.filter((r) => {
      const email = r.prospect_email?.trim().toLowerCase();
      return email != null && wantedEmails.has(email);
    });
  }
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
  if (isDraining()) {
    return jsonResponse({ error: "server restarting — retry in a moment" }, 503, req);
  }
  const parsed = parseProspectAndPlay(req, params);
  if (parsed instanceof Response) return parsed;
  // Verify the preview exists synchronously so we can 409 the founder
  // immediately if they clicked Send without a persisted draft — but the
  // actual send is fire-and-forget. SDK email send takes ~2 min; blocking
  // the modal that long is bad UX, especially since the founder already
  // approved by confirming. Mirrors POST /api/cadences/send-batch.
  const ledger = getLedger();
  try {
    const draft = ledger.getCadenceDraft(parsed);
    if (!draft) {
      return jsonResponse({ error: "no persisted preview — click Preview first" }, 409, req);
    }
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "send failed" }, 500, req);
  }
  // Atomic claim — survives server restart. `staleCutoffIso` lets a fresh
  // click reclaim a marker stranded by a previous restart (the cold-boot
  // sweep also clears these, but a fast retry shouldn't have to wait).
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - MAX_SEND_AGE_MS).toISOString();
  const claimed = ledger.claimCadenceSendingMarker({
    prospectId: parsed.prospectId,
    playName: parsed.playName,
    startedAtIso: nowIso,
    staleCutoffIso,
  });
  if (!claimed) {
    return jsonResponse({ error: "already sending — wait for the in-flight send to complete" }, 409, req);
  }
  void (async () => {
    try {
      await sendCadenceStep(parsed);
      // Success path: advanceCadence inside sendCadenceStep already cleared
      // sending_started_at as part of its UPDATE. Nothing to do here.
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
      // Failure path: advanceCadence never ran, so the marker is stuck.
      // Release it so the founder can re-Send without waiting for the sweep.
      try {
        ledger.clearCadenceSendingMarker(parsed);
      } catch {
        // Ledger write failing is the sweeper's problem; not worth re-throwing.
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
  // Claim each row's marker atomically. Rows that fail to claim (already
  // sending) are dropped from the batch — `accepted` reflects the actual
  // attempt count.
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
  void (async () => {
    try {
      // Per-item callback: clear the marker on each settled row. The serial
      // sendCadenceStepBatch already calls advanceCadence on success (which
      // clears the marker as part of the same UPDATE), so this catches the
      // failure path only — defensive clear is idempotent.
      await sendCadenceStepBatch(claimed, (item) => {
        try {
          ledger.clearCadenceSendingMarker(item);
        } catch {
          /* sweeper safety net */
        }
      });
    } catch (err) {
      // Belt-and-suspenders: the wrapper catches per-item; this catch only
      // fires if the wrapper itself throws. Release everything so the founder
      // can retry without waiting for the sweep.
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
