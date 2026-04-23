import { getLedger } from "@oneshot-gtm/core";
import type { HomeMetrics } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

export function homeMetrics(req: Request): Response {
  const ledger = getLedger();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const recent7d = ledger.listReceipts({ sinceIso: sevenDaysAgo, limit: 1000 });
  const events7d = ledger.eventsByPlay({ sinceIso: sevenDaysAgo });
  const sent7d = events7d.reduce((acc, e) => acc + e.sent, 0);
  const replied7d = events7d.reduce((acc, e) => acc + e.replied, 0);
  const active = ledger.listActiveCadences();

  const metrics: HomeMetrics = {
    spendUsd7d: ledger.totalSpendUsd({ sinceIso: sevenDaysAgo }),
    spendUsd30d: ledger.totalSpendUsd({ sinceIso: thirtyDaysAgo }),
    callsLast7d: recent7d.length,
    sentLast7d: sent7d,
    repliedLast7d: replied7d,
    activeCadences: active.length,
  };

  return jsonResponse(metrics, 200, req);
}
