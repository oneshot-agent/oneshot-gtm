import { currentMember } from "../members.ts";
import { jsonResponse } from "../server.ts";

/** `GET /api/me`: the member this request acts as. The request gate has already refused non-members. */
export function meRoute(req: Request): Response {
  const member = currentMember(req);
  if (!member) return jsonResponse({ error: "forbidden: not a member" }, 403, req);
  return jsonResponse(member, 200, req);
}
