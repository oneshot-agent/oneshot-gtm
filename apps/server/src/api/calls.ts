/**
 * The dialler's routes (plays `_calls.ts`):
 *  - GET /api/calls: the Calls page's lists. Cheap when calls are off: the
 *    nav reads it to decide whether to show the page.
 *  - POST /api/calls/brief {prospectId, playName?, regenerate?}: the brief
 *    for the dial panel. A due call step's stored preview, else a cached
 *    on-demand brief; a paid completion only when none is stored or
 *    `regenerate` (body, or `?regenerate=1`) asks for a new one.
 *  - POST /api/prospects/:id/call (LogCallRequest): log an outcome.
 *  - GET /api/prospects/:id/calls: the prospect's calls, newest first.
 */
import { callsOf, getLedger, loadConfig } from "@oneshot-gtm/core";
import { CallLogError, callBriefFor, listCalls, recordCall } from "@oneshot-gtm/plays";
import { isCallOutcome, type LogCallRequest } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/** Longest note kept on a call. */
const MAX_NOTE_CHARS = 4000;

export function listCallsRoute(req: Request): Response {
  try {
    return jsonResponse(listCalls(), 200, req);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "calls failed" }, 500, req);
  }
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return jsonResponse({ error: "body must be a JSON object" }, 400, req);
    return body as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "body must be JSON" }, 400, req);
  }
}

function prospectIdOf(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export async function callBriefRoute(req: Request): Promise<Response> {
  if (!callsOf(loadConfig()).enabled)
    return jsonResponse({ error: "calls are off for this workspace" }, 409, req);
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const prospectId = prospectIdOf(body["prospectId"]);
  if (prospectId == null) return jsonResponse({ error: "prospectId required" }, 400, req);
  const playName = body["playName"];
  if (playName !== undefined && playName !== null && typeof playName !== "string")
    return jsonResponse({ error: "playName must be a string" }, 400, req);
  const regenerate =
    body["regenerate"] === true || new URL(req.url).searchParams.get("regenerate") === "1";
  if (!getLedger().getProspectById(prospectId))
    return jsonResponse({ error: "prospect not found" }, 404, req);
  try {
    const brief = await callBriefFor({
      prospectId,
      ...(typeof playName === "string" && playName ? { playName } : {}),
      regenerate,
    });
    return jsonResponse({ brief }, 200, req);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "brief failed" }, 502, req);
  }
}

export async function logCallRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const prospectId = prospectIdOf(params["id"]);
  if (prospectId == null) return jsonResponse({ error: "bad id" }, 400, req);
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  if (!isCallOutcome(body["outcome"]))
    return jsonResponse({ error: "outcome must be one of the call outcomes" }, 400, req);
  const note = body["note"];
  if (note !== undefined && note !== null && typeof note !== "string")
    return jsonResponse({ error: "note must be text" }, 400, req);
  if (typeof note === "string" && note.length > MAX_NOTE_CHARS)
    return jsonResponse({ error: `note must be under ${MAX_NOTE_CHARS} characters` }, 400, req);
  const duration = body["durationSec"];
  if (
    duration !== undefined &&
    duration !== null &&
    (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
  )
    return jsonResponse({ error: "durationSec must be a non-negative number" }, 400, req);
  const callId = body["callId"];
  if (callId !== undefined && callId !== null && prospectIdOf(callId) == null)
    return jsonResponse({ error: "callId must be a call id" }, 400, req);
  const holdUntil = body["holdUntil"];
  if (
    holdUntil !== undefined &&
    holdUntil !== null &&
    (typeof holdUntil !== "string" || !Number.isFinite(Date.parse(holdUntil)))
  )
    return jsonResponse({ error: "holdUntil must be a date (YYYY-MM-DD)" }, 400, req);
  const playName = body["playName"];
  if (playName !== undefined && playName !== null && typeof playName !== "string")
    return jsonResponse({ error: "playName must be a string" }, 400, req);
  const request: LogCallRequest = {
    outcome: body["outcome"],
    ...(typeof note === "string" ? { note } : {}),
    ...(typeof duration === "number" ? { durationSec: duration } : {}),
    ...(callId != null ? { callId: prospectIdOf(callId)! } : {}),
    ...(typeof playName === "string" && playName ? { playName } : {}),
    ...(typeof holdUntil === "string" ? { holdUntil } : {}),
  };
  try {
    return jsonResponse({ call: recordCall(prospectId, request) }, 200, req);
  } catch (err) {
    if (err instanceof CallLogError) return jsonResponse({ error: err.message }, err.status, req);
    return jsonResponse({ error: (err as Error).message ?? "logging the call failed" }, 500, req);
  }
}

export function prospectCallsRoute(req: Request, params: Record<string, string>): Response {
  const prospectId = prospectIdOf(params["id"]);
  if (prospectId == null) return jsonResponse({ error: "bad id" }, 400, req);
  return jsonResponse({ calls: getLedger().listCallsForProspect(prospectId) }, 200, req);
}
