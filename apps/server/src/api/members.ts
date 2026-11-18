import { getSharedDb, LastOwnerError, normalizeMemberEmail } from "@oneshot-gtm/core";
import type { MembersView } from "@oneshot-gtm/shared-types";
import { currentMember } from "../members.ts";
import { jsonResponse } from "../server.ts";

export function membersRoute(req: Request): Response {
  const member = currentMember(req);
  if (!member) return jsonResponse({ error: "forbidden: not a member" }, 403, req);
  const db = getSharedDb();
  const view: MembersView = {
    members: db.listMembers().map((m) => ({
      email: m.email,
      name: m.name,
      role: m.role,
      addedAt: m.added_at,
    })),
    allowedHosts: db.allowedHosts(),
    currentMember: member,
  };
  const response = jsonResponse(view, 200, req);
  response.headers.set("cache-control", "no-store");
  return response;
}

async function mutate(req: Request, action: "add" | "remove" | "role"): Promise<Response> {
  if (currentMember(req)?.role !== "owner") {
    return jsonResponse({ error: "Only owners can manage members." }, 403, req);
  }
  let body: { email?: unknown; role?: unknown };
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return jsonResponse({ error: "Expected a JSON object." }, 400, req);
  }
  // Reading the body yields: recheck in case the requester was removed or demoted meanwhile.
  if (currentMember(req)?.role !== "owner") {
    return jsonResponse({ error: "Only owners can manage members." }, 403, req);
  }
  const email = typeof body.email === "string" ? normalizeMemberEmail(body.email) : null;
  if (!email) return jsonResponse({ error: "Enter a valid member email." }, 400, req);
  if (action === "role" && body.role !== "owner" && body.role !== "member") {
    return jsonResponse({ error: "Role must be owner or member." }, 400, req);
  }
  const db = getSharedDb();
  const existing = db.activeMember(email);
  if (action !== "add" && !existing) {
    return jsonResponse({ error: "No active member with that email." }, 404, req);
  }
  try {
    if (action === "remove") db.removeMember(email);
    else if (action === "role") {
      if (!db.setMemberRole(email, body.role as "owner" | "member")) {
        return jsonResponse({ error: "No active member with that email." }, 404, req);
      }
    } else {
      // Adding an existing email is safe to retry and preserves its role and name.
      db.addMember({
        email,
        role: existing?.role ?? "member",
      });
    }
  } catch (err) {
    if (err instanceof LastOwnerError) return jsonResponse({ error: err.message }, 409, req);
    throw err;
  }
  return jsonResponse({ ok: true }, 200, req);
}

export const addMemberRoute = (req: Request) => mutate(req, "add");
export const removeMemberRoute = (req: Request) => mutate(req, "remove");
export const memberRoleRoute = (req: Request) => mutate(req, "role");
