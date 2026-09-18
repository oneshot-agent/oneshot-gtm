import { getLedger } from "@oneshot-gtm/core";
import { resolveQueueContact, resolveQueueTarget } from "@oneshot-gtm/find";
import { jsonResponse } from "../server.ts";

const resolving = new Set<number>();

/** Explicit paid recovery; listing or approving a row never buys a lookup. */
export async function resolveQueueContactRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number(params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: "row not found" }, 404, req);
  if (row.status !== "approved" || row.send_started_at)
    return jsonResponse({ error: "Only approved, idle rows can resolve contacts" }, 409, req);
  if (resolving.has(id))
    return jsonResponse({ error: "Contact lookup already in progress" }, 409, req);
  resolving.add(id);
  try {
    const patch = await resolveQueueContact(row);
    const current = ledger.getQueueRow(id);
    if (
      !current ||
      current.status !== "approved" ||
      current.send_started_at ||
      current.payload_json !== row.payload_json
    ) {
      return jsonResponse(
        { error: "Row changed during lookup; refresh before retrying" },
        409,
        req,
      );
    }
    // Do not persist the trigger's current edge over the historical payload.
    const payload = { ...JSON.parse(current.payload_json), ...patch };
    const resolved = resolveQueueTarget({ ...current, payload_json: JSON.stringify(payload) });
    ledger.updateQueuePayload({ id, payload });
    return jsonResponse({ ok: true, payload: resolved }, 200, req);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 422, req);
  } finally {
    resolving.delete(id);
  }
}
