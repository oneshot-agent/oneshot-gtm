import {
  currentWorkspaceName,
  demoMode,
  getLedger,
  isSendDeferred,
  linkedInFriendViewNow,
  linkedInOutreachAccount,
} from "@oneshot-gtm/core";
import { draftFriendNote, sendFriendInvite } from "@oneshot-gtm/plays";
import type {
  LinkedInFriendDraftView,
  LinkedInFriendSendView,
  LinkedInFriendView,
} from "@oneshot-gtm/shared-types";
import { callLinkedIn } from "../linkedin-client.ts";
import { isLoopbackOrigin, jsonResponse } from "../server.ts";

/**
 * The warm LinkedIn connect for people who replied to an email (#791). Three
 * routes, none automatic: the state of the action, a draft to preview, and the
 * send of the note the founder reviewed.
 */

function prospectIdOf(params: Record<string, string>): number | null {
  const id = Number.parseInt(params["id"] ?? "", 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/prospects/:id/linkedin-friend: is Connect on LinkedIn offered, and the invite's state. */
export function linkedInFriendRoute(req: Request, params: Record<string, string>): Response {
  const id = prospectIdOf(params);
  if (id === null) return jsonResponse({ error: "bad id" }, 400, req);
  if (demoMode()) {
    const view: LinkedInFriendView = { canConnect: false, reason: "read-only demo", invite: null };
    return jsonResponse(view, 200, req);
  }
  const view: LinkedInFriendView = linkedInFriendViewNow(id);
  // No account, or one without the invite grant, can't send: don't offer it.
  if (view.canConnect) {
    const account = linkedInOutreachAccount();
    const reason = !account
      ? "connect LinkedIn on /setup first"
      : !account.canInvite
        ? "allow connection requests on Replies"
        : null;
    if (reason) return jsonResponse({ canConnect: false, reason, invite: null }, 200, req);
  }
  return jsonResponse(view, 200, req);
}

function writeGuard(req: Request): Response | null {
  if (demoMode()) return jsonResponse({ error: "Read-only demo" }, 403, req);
  if (!isLoopbackOrigin(req.headers.get("origin") ?? "")) {
    return jsonResponse({ error: "forbidden origin" }, 403, req);
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "JSON is required" }, 400, req);
  }
  return null;
}

/** POST /api/prospects/:id/linkedin-friend/draft: draft the note. Sends nothing. */
export async function linkedInFriendDraftRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const refused = writeGuard(req);
  if (refused) return refused;
  const id = prospectIdOf(params);
  if (id === null) return jsonResponse({ error: "bad id" }, 400, req);
  if (!getLedger().getProspectById(id)) {
    return jsonResponse({ error: "prospect not found" }, 404, req);
  }
  try {
    const out = await draftFriendNote(id);
    if (!out.ok) return jsonResponse({ error: out.reason }, 409, req);
    const view: LinkedInFriendDraftView = out.draft;
    return jsonResponse(view, 200, req);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "draft failed" }, 502, req);
  }
}

/** POST /api/prospects/:id/linkedin-friend/send `{ note }`: send the note exactly as reviewed. */
export async function linkedInFriendSendRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const refused = writeGuard(req);
  if (refused) return refused;
  const id = prospectIdOf(params);
  if (id === null) return jsonResponse({ error: "bad id" }, 400, req);
  let note: unknown;
  try {
    const body: unknown = await req.json();
    note = body && typeof body === "object" ? (body as { note?: unknown }).note : undefined;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof note !== "string" || !note.trim()) {
    return jsonResponse({ error: "note is required: preview and edit it, then send" }, 400, req);
  }
  const account = linkedInOutreachAccount();
  if (!account) {
    return jsonResponse({ error: "connect LinkedIn on /setup before sending invites" }, 409, req);
  }
  if (!account.canInvite) {
    return jsonResponse({ error: "allow connection requests on Replies" }, 409, req);
  }
  try {
    const out = await sendFriendInvite({
      prospectId: id,
      note,
      sender: {
        accountId: account.accountId,
        workspace: account.workspace,
        call: (operation) => callLinkedIn(account.workspace, operation),
      },
      workspace: currentWorkspaceName(),
    });
    if (!out.sent) {
      return jsonResponse({ error: out.flags.join("; "), flags: out.flags }, 409, req);
    }
    const view: LinkedInFriendSendView = {
      ok: true,
      invitationId: out.invitationId,
      status: out.status,
    };
    return jsonResponse(view, 200, req);
  } catch (err) {
    const message = (err as Error).message ?? "LinkedIn invite failed";
    return jsonResponse({ error: message }, isSendDeferred(err) ? 429 : 502, req);
  }
}
