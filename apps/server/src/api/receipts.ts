import { getLedger } from "@oneshot-gtm/core";
import type { ReceiptDetail, ReceiptView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function toView(row: {
  id: number;
  play_name: string;
  call_type: string;
  cost_usd: number | null;
  oneshot_request_id: string | null;
  created_at: string;
}): ReceiptView {
  return {
    id: row.id,
    playName: row.play_name,
    callType: row.call_type,
    costUsd: row.cost_usd,
    oneshotRequestId: row.oneshot_request_id,
    createdAt: row.created_at,
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
  const detail: ReceiptDetail = {
    id: r.id,
    playName: r.play_name,
    callType: r.call_type,
    costUsd: r.cost_usd,
    oneshotRequestId: r.oneshot_request_id,
    createdAt: r.created_at,
    signedReceipt: parsed,
  };
  return jsonResponse({ receipt: detail }, 200, req);
}
