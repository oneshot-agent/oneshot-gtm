/**
 * The dialler's routes (plays `_calls.ts`). GET /api/calls stays cheap when
 * calls are off, since the nav reads it to decide whether to show the page.
 * POST /api/calls/brief pays for a completion only when no brief is stored or
 * `regenerate` asks for one.
 */
import { callsOf, getLedger, loadConfig } from "@oneshot-gtm/core";
import {
  CallLogError,
  PREVIEW_STEP_MOVED,
  callBriefFor,
  listCalls,
  recordCall,
} from "@oneshot-gtm/plays";
import { isCallOutcome, type LogCallRequest } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/** Longest note kept on a call. */
const MAX_NOTE_CHARS = 4000;
/** Longest dialled number read: a number with its extension fits. */
const MAX_PHONE_CHARS = 64;
/** A save's id from the dashboard. */
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
    const message = (err as Error).message ?? "brief failed";
    // The cadence moved on while the brief was written: nothing was stored.
    return jsonResponse({ error: message }, message === PREVIEW_STEP_MOVED ? 409 : 502, req);
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
  const phone = body["phone"];
  if (
    phone !== undefined &&
    phone !== null &&
    (typeof phone !== "string" || phone.length > MAX_PHONE_CHARS)
  )
    return jsonResponse({ error: "phone must be the number dialled" }, 400, req);
  const currentStep = body["currentStep"];
  if (
    currentStep !== undefined &&
    currentStep !== null &&
    (typeof currentStep !== "number" || !Number.isInteger(currentStep) || currentStep < 0)
  )
    return jsonResponse({ error: "currentStep must be a step index" }, 400, req);
  const clientKey = body["clientKey"];
  if (
    clientKey !== undefined &&
    clientKey !== null &&
    (typeof clientKey !== "string" || !CLIENT_KEY_RE.test(clientKey))
  )
    return jsonResponse({ error: "clientKey must be 8–64 letters, digits, - or _" }, 400, req);
  const request: LogCallRequest = {
    outcome: body["outcome"],
    ...(typeof note === "string" ? { note } : {}),
    ...(typeof duration === "number" ? { durationSec: duration } : {}),
    ...(callId != null ? { callId: prospectIdOf(callId)! } : {}),
    ...(typeof playName === "string" && playName ? { playName } : {}),
    ...(typeof holdUntil === "string" ? { holdUntil } : {}),
    ...(typeof phone === "string" && phone.trim() ? { phone } : {}),
    ...(currentStep !== undefined ? { currentStep: currentStep as number | null } : {}),
    ...(typeof clientKey === "string" ? { clientKey } : {}),
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
