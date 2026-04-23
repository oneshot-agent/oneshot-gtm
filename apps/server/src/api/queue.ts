import { getLedger, type QueueRow, type QueueStatus } from "@oneshot-gtm/core";
import { drainQueue } from "@oneshot-gtm/find";
import type {
  DrainRequest,
  DrainResult,
  QueueCounts,
  QueueRowView,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function toView(row: QueueRow): QueueRowView {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  return {
    id: row.id,
    playName: row.play_name,
    payload,
    dedupeKey: row.dedupe_key,
    source: row.source,
    status: row.status,
    foundAt: row.found_at,
    reviewedAt: row.reviewed_at,
    sentAt: row.sent_at,
    notes: row.notes,
    prospectId: row.prospect_id,
  };
}

export function listQueueRoute(req: Request): Response {
  const url = new URL(req.url);
  const playName = url.searchParams.get("play") ?? undefined;
  const status = (url.searchParams.get("status") ?? undefined) as QueueStatus | undefined;
  const limit = Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200);
  const ledger = getLedger();
  const filterArgs: { playName?: string; status?: QueueStatus; limit?: number } = { limit };
  if (playName) filterArgs.playName = playName;
  if (status) filterArgs.status = status;
  const rows = ledger.listQueue(filterArgs);
  const counts: QueueCounts = ledger.queueCounts();
  return jsonResponse({ rows: rows.map(toView), counts }, 200, req);
}

export async function approveQueueRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  ledger.setQueueStatus({ id, status: "approved" });
  return jsonResponse({ ok: true }, 200, req);
}

export async function rejectQueueRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  let body: { reason?: string } = {};
  try {
    body = (await req.json()) as { reason?: string };
  } catch {
    // empty body is fine
  }
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  ledger.setQueueStatus(
    body.reason ? { id, status: "rejected", notes: body.reason } : { id, status: "rejected" },
  );
  return jsonResponse({ ok: true }, 200, req);
}

export async function approveAllRoute(req: Request): Promise<Response> {
  let body: { play?: string } = {};
  try {
    body = (await req.json()) as { play?: string };
  } catch {
    // empty body is fine
  }
  const ledger = getLedger();
  const n = ledger.approveAllPending(body.play ? { playName: body.play } : {});
  return jsonResponse({ approved: n }, 200, req);
}

export async function drainQueueRoute(req: Request): Promise<Response> {
  let body: DrainRequest;
  try {
    body = (await req.json()) as DrainRequest;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!body.playName) return jsonResponse({ error: "playName required" }, 400, req);
  const result = await drainQueue({
    playName: body.playName,
    limit: body.limit ?? 10,
    dryRun: !!body.dryRun,
    ...(body.senderCohort ? { senderCohort: body.senderCohort } : {}),
    ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
  });
  const view: DrainResult = {
    drained: result.drained,
    sent: result.sent,
    errors: result.errors,
  };
  return jsonResponse(view, 200, req);
}
