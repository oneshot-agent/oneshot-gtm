import { logEvent, pauseSendingDomain, resumeSendingDomain } from "@oneshot-gtm/core";
import type { DomainActionResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * Resume / pause a wallet-owned sending domain in the OneShot pool. The /setup
 * UI calls these to act on a paused domain (the doctor flags one); the CLI
 * (`oneshot-gtm domains resume/pause`) hits the same core wrappers.
 *
 * Errors are surfaced verbatim (incl. the platform HTTP status) rather than
 * swallowed — a paused domain that won't resume because OneShot is returning
 * 500s is exactly what the founder needs to see, not a silent no-op.
 */
async function domainActionRoute(
  req: Request,
  action: "resume" | "pause",
): Promise<Response> {
  let body: { domain?: unknown };
  try {
    body = (await req.json()) as { domain?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof body.domain !== "string" || body.domain.trim().length === 0) {
    return jsonResponse({ error: "domain (string) required" }, 400, req);
  }
  const domain = body.domain.trim().toLowerCase();

  try {
    const result =
      action === "resume" ? await resumeSendingDomain(domain) : await pauseSendingDomain(domain);
    const out: DomainActionResult = { domain: result.domain, poolStatus: result.pool_status };
    return jsonResponse(out, 200, req);
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    logEvent(
      `domains.${action}_failed`,
      { domain, status_code: typeof e?.statusCode === "number" ? e.statusCode : null },
      "warn",
    );
    // Mirror the run-route style: include the platform HTTP status so a 500
    // (OneShot outage) reads differently from a 4xx (bad domain / not owned).
    const sc = typeof e?.statusCode === "number" ? e.statusCode : null;
    const msg = e?.message ?? `${action} failed`;
    const detail = sc != null ? ` (OneShot HTTP ${sc})` : "";
    // Pass a client error (bad/unowned domain) through as 4xx; treat a platform
    // 5xx / unknown failure as 502 (we're the gateway to OneShot here).
    const httpStatus = sc != null && sc >= 400 && sc < 500 ? sc : 502;
    return jsonResponse({ error: `${msg}${detail}` }, httpStatus, req);
  }
}

export function resumeDomainRoute(req: Request): Promise<Response> {
  return domainActionRoute(req, "resume");
}

export function pauseDomainRoute(req: Request): Promise<Response> {
  return domainActionRoute(req, "pause");
}
