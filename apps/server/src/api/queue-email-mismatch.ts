import { getLedger, safeParseJsonRecord } from "@oneshot-gtm/core";
import { emailMismatchHold } from "@oneshot-gtm/plays";
import { jsonResponse } from "../server.ts";

/**
 * POST /api/queue/:id/email-mismatch `{ approve: true }`: the founder sends to
 * the row's address although it lands at none of the companies person
 * research says the person works at now. The approval names that exact
 * address, so a changed address is checked again. 409 when the row is no
 * longer pending or approved, or its address changed underneath the request.
 */
export async function approveEmailMismatchRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || (body as { approve?: unknown }).approve !== true) {
    return jsonResponse({ error: "body must be { approve: true }" }, 400, req);
  }
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  const payload = safeParseJsonRecord(row.payload_json);
  if (!payload) return jsonResponse({ error: "row payload is not valid JSON" }, 400, req);
  if (!emailMismatchHold(payload)) {
    return jsonResponse({ error: "the row's send is not held for its address" }, 400, req);
  }
  const email = typeof payload["email"] === "string" ? payload["email"].trim() : "";
  if (!email) return jsonResponse({ error: "the row has no address to approve" }, 400, req);
  const ok = ledger.patchLiveQueuePayload({
    id,
    patch: { emailMismatchApproved: email.toLowerCase() },
    expect: [{ path: "$.email", value: payload["email"] as string }],
  });
  if (!ok) {
    return jsonResponse(
      { error: "row is no longer pending or approved, or its address changed" },
      409,
      req,
    );
  }
  return jsonResponse({ ok: true, approved: email.toLowerCase() }, 200, req);
}
