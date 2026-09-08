import { getLedger } from "@oneshot-gtm/core";
import type { HomeMetrics } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { sendsToday } from "./_capacity.ts";

export function homeMetrics(req: Request): Response {
  const ledger = getLedger();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const events7d = ledger.eventsByPlay({ sinceIso: sevenDaysAgo });
  const sent7d = events7d.reduce((acc, e) => acc + e.sent, 0);
  const replied7d = events7d.reduce((acc, e) => acc + e.replied, 0);
  const active = ledger.listActiveCadences();

  const metrics: HomeMetrics = {
    spendUsd7d: ledger.totalSpendUsd({ sinceIso: sevenDaysAgo }),
    spendUsd30d: ledger.totalSpendUsd({ sinceIso: thirtyDaysAgo }),
    callsLast7d: ledger.countReceipts({ sinceIso: sevenDaysAgo }),
    sentLast7d: sent7d,
    repliedLast7d: replied7d,
    activeCadences: active.length,
    // Onboarding must not infer this from a filtered/paginated queue response:
    // queue rows can be removed or change status after a real send. Sequence
    // events are the durable record of transport success.
    hasFirstSend: ledger.countSends() > 0,
    // In-flight /run dispatches — surfaces a "Resume" link on the home dashboard
    // so the founder can hop back to a running batch without remembering the URL.
    // Capped at 5 (the widget hides itself when empty).
    currentRuns: ledger.listRuns({ status: "running", limit: 5 }),
  };
  const capacity = sendsToday();
  if (capacity) metrics.sendsToday = capacity;

  return jsonResponse(metrics, 200, req);
}
