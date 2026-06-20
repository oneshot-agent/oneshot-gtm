import { getLedger } from "@oneshot-gtm/core";
import type { ReceiptRecord } from "@oneshot-gtm/core";
import type { ReceiptDetail, ReceiptValueTag, ReceiptView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/** Parse the JSON `value_tag` column to the wire shape; null on absent/garbage. */
function parseValueTag(raw: string | null): ReceiptValueTag | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ReceiptValueTag;
    return v && typeof v.type === "string" ? v : null;
  } catch {
    return null;
  }
}

function toView(row: ReceiptRecord): ReceiptView {
  return {
    id: row.id,
    playName: row.play_name,
    callType: row.call_type,
    costUsd: row.cost_usd,
    oneshotRequestId: row.oneshot_request_id,
    createdAt: row.created_at,
    memo: row.memo,
    valueTag: parseValueTag(row.value_tag),
  };
}

export function listReceipts(req: Request): Response {
  const url = new URL(req.url);
  const playName = url.searchParams.get("play") ?? undefined;
  const sinceDays = Number.parseInt(url.searchParams.get("sinceDays") ?? "", 10);
  const limit = Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200);
  const sinceIso = Number.isFinite(sinceDays)
    ? new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString()
    : undefined;

  const ledger = getLedger();
  const rows = ledger.listReceipts({
    ...(playName ? { playName } : {}),
    ...(sinceIso ? { sinceIso } : {}),
    limit,
  });
  return jsonResponse({ receipts: rows.map(toView) }, 200, req);
}

export function getReceipt(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const r = getLedger().getReceipt(id);
  if (!r) return jsonResponse({ error: "not found" }, 404, req);
  let parsed: unknown = null;
  if (r.signed_receipt) {
    try {
      parsed = JSON.parse(r.signed_receipt);
    } catch {
      parsed = r.signed_receipt;
    }
  }
  let decisionContext: unknown = null;
  if (r.decision_context) {
    try {
      decisionContext = JSON.parse(r.decision_context);
    } catch {
      decisionContext = r.decision_context;
    }
  }
  const detail: ReceiptDetail = {
    ...toView(r),
    signedReceipt: parsed,
    decisionContext,
  };
  return jsonResponse({ receipt: detail }, 200, req);
}
