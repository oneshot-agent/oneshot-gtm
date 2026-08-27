import { poolSendCapacity } from "@oneshot-gtm/core";
import type { SendsToday } from "@oneshot-gtm/shared-types";

/**
 * Whole-pool sends-today for the dashboard pages. Best-effort: a capacity
 * failure (unreadable config, ledger hiccup) must never take down the page —
 * callers attach the field only when it resolves.
 */
export function sendsToday(): SendsToday | undefined {
  try {
    const pool = poolSendCapacity();
    return { sent: pool.sentToday, cap: pool.capToday };
  } catch {
    return undefined;
  }
}
