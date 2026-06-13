import { activeSendCount, isDraining } from "@oneshot-gtm/core";
import { jsonResponse } from "../server.ts";

/**
 * Liveness + in-flight-send count. Exposes the same in-memory `activeSendCount()`
 * the shutdown drain reads, so an external restart flow can wait for sends to
 * finish before sending SIGTERM (instead of force-killing through them). The DB
 * `sending_started_at` markers can't substitute — they survive a crash and lag
 * the live counter, so they over-report.
 */
export function health(req: Request): Response {
  return jsonResponse(
    { ok: true, inFlightSends: activeSendCount(), draining: isDraining() },
    200,
    req,
  );
}
