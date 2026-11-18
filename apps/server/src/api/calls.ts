/**
 * The dialler's routes (plays `_calls.ts`). GET /api/calls stays cheap when
 * calls are off, since the nav reads it to decide whether to show the page.
 * POST /api/calls/brief pays for a completion only when no brief is stored or
 * `regenerate` asks for one.
 */
import { callsOf, getLedger, loadConfig } from "@oneshot-gtm/core";
import {
  CallBridgeRequestError,
  CallLogError,
  PREVIEW_STEP_MOVED,
  callBriefFor,
  callsMe,
  checkMemberPhone,
  discardBridgedRecording,
  hangUpBridgedCall,
  listCalls,
  memberCanBridge,
  recordCall,
  refreshBridgedCall,
  removeMemberPhone,
  assertCallActor,
  startBridgedCall,
  startBridgedRecording,
  verifyMemberPhone,
} from "@oneshot-gtm/plays";
import { isCallOutcome, type LogCallRequest } from "@oneshot-gtm/shared-types";
import { currentMember } from "../members.ts";
import { jsonResponse } from "../server.ts";

/** Longest note kept on a call. */
const MAX_NOTE_CHARS = 4000;
/** Most promises kept on a call, and the longest one. */
const MAX_COMMITMENTS = 10;
const MAX_COMMITMENT_CHARS = 300;
/** Longest dialled number read: a number with its extension fits. */
const MAX_PHONE_CHARS = 64;
/** A save's id from the dashboard. */
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function listCallsRoute(req: Request): Response {
  try {
    const out = listCalls();
    const member = currentMember(req);
    const bridged = out.dialMode === "bridge" && member != null && memberCanBridge(member.email);
    return jsonResponse({ ...out, dialMode: bridged ? "bridge" : "tel" }, 200, req);
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
  const commitments = body["commitments"];
  if (
    commitments !== undefined &&
    commitments !== null &&
    (!Array.isArray(commitments) ||
      commitments.length > MAX_COMMITMENTS ||
      commitments.some((c) => typeof c !== "string" || c.length > MAX_COMMITMENT_CHARS))
  )
    return jsonResponse(
      { error: `commitments must be up to ${MAX_COMMITMENTS} short lines of text` },
      400,
      req,
    );
  const currentStep = body["currentStep"];
  if (
    currentStep !== undefined &&
    currentStep !== null &&
    (typeof currentStep !== "number" || !Number.isInteger(currentStep) || currentStep < 0)
  )
    return jsonResponse({ error: "currentStep must be a step index" }, 400, req);
  const enrolledAt = body["enrolledAt"];
  if (
    enrolledAt !== undefined &&
    enrolledAt !== null &&
    (typeof enrolledAt !== "string" || !enrolledAt || enrolledAt.length > 64)
  )
    return jsonResponse({ error: "enrolledAt must be the cadence's enrolment time" }, 400, req);
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
    ...(Array.isArray(commitments)
      ? { commitments: (commitments as string[]).map((c) => c.trim()).filter(Boolean) }
      : {}),
    ...(currentStep !== undefined ? { currentStep: currentStep as number | null } : {}),
    ...(typeof enrolledAt === "string" ? { enrolledAt } : {}),
    ...(typeof clientKey === "string" ? { clientKey } : {}),
  };
  try {
    const member = currentMember(req)?.email ?? null;
    const call = recordCall(prospectId, request, new Date(), member);
    return jsonResponse({ call }, 200, req);
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

// Bridged calls (docs/calls.md): every route acts for the requesting member,
// so a request that is nobody's is refused even past the server's own gate.

function memberOf(req: Request): { email: string | null; role: "owner" | "member" } | Response {
  const member = currentMember(req);
  return member
    ? { email: member.email, role: member.role }
    : jsonResponse({ error: "sign in as a member to use calls" }, 403, req);
}

function bridgeError(req: Request, err: unknown, fallback: string): Response {
  if (err instanceof CallBridgeRequestError)
    return jsonResponse({ error: err.message }, err.status, req);
  return jsonResponse({ error: (err as Error).message ?? fallback }, 500, req);
}

export function callsMeRoute(req: Request): Response {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  return jsonResponse(callsMe(member.email), 200, req);
}

export async function verifyPhoneRoute(req: Request): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const phone = body["phone"];
  if (typeof phone !== "string" || !phone.trim() || phone.length > MAX_PHONE_CHARS)
    return jsonResponse({ error: "phone required" }, 400, req);
  try {
    return jsonResponse(await verifyMemberPhone(member.email, phone), 200, req);
  } catch (err) {
    return bridgeError(req, err, "verifying the phone failed");
  }
}

export async function checkPhoneRoute(req: Request): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  try {
    return jsonResponse(await checkMemberPhone(member.email), 200, req);
  } catch (err) {
    return bridgeError(req, err, "checking the phone failed");
  }
}

export async function removePhoneRoute(req: Request): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  try {
    return jsonResponse(await removeMemberPhone(member.email), 200, req);
  } catch (err) {
    return bridgeError(req, err, "removing the phone failed");
  }
}

export async function startCallRoute(req: Request): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const prospectId = prospectIdOf(body["prospectId"]);
  if (prospectId == null) return jsonResponse({ error: "prospectId required" }, 400, req);
  const playName = body["playName"];
  if (playName !== undefined && playName !== null && typeof playName !== "string")
    return jsonResponse({ error: "playName must be a string" }, 400, req);
  try {
    const call = await startBridgedCall({
      prospectId,
      playName: typeof playName === "string" ? playName : null,
      member: member.email,
    });
    return jsonResponse(call, 200, req);
  } catch (err) {
    return bridgeError(req, err, "starting the call failed");
  }
}

export async function getCallRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  const id = prospectIdOf(params["id"]);
  if (id == null) return jsonResponse({ error: "bad id" }, 400, req);
  try {
    return jsonResponse(await refreshBridgedCall(id), 200, req);
  } catch (err) {
    return bridgeError(req, err, "reading the call failed");
  }
}

export async function hangUpCallRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  const id = prospectIdOf(params["id"]);
  if (id == null) return jsonResponse({ error: "bad id" }, 400, req);
  try {
    assertCallActor(id, member, "hangup");
    return jsonResponse(await hangUpBridgedCall(id), 200, req);
  } catch (err) {
    return bridgeError(req, err, "hanging up failed");
  }
}

/** The prospect agreed to recording: record the connected call from now. */
export async function recordCallRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  const id = prospectIdOf(params["id"]);
  if (id == null) return jsonResponse({ error: "bad id" }, 400, req);
  try {
    assertCallActor(id, member, "record");
    return jsonResponse(await startBridgedRecording(id), 200, req);
  } catch (err) {
    return bridgeError(req, err, "starting the recording failed");
  }
}

/** The prospect declined recording: delete it, whether or not an outcome is logged. */
export async function discardRecordingRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const member = memberOf(req);
  if (member instanceof Response) return member;
  const id = prospectIdOf(params["id"]);
  if (id == null) return jsonResponse({ error: "bad id" }, 400, req);
  try {
    assertCallActor(id, member, "discard");
    return jsonResponse(await discardBridgedRecording(id), 200, req);
  } catch (err) {
    return bridgeError(req, err, "deleting the recording failed");
  }
}
