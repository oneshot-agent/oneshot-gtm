import { getLedger } from "@oneshot-gtm/core";
import { resolveQueueTarget } from "@oneshot-gtm/find";
import {
  deriveOffer,
  OFFER_MAX,
  OFFER_PROMPT_VERSION,
  offerOf,
  playMakesOffer,
  type ProspectOffer,
} from "@oneshot-gtm/plays";
import { jsonResponse } from "../server.ts";

/**
 * POST /api/queue/:id/offer: the founder edits a row's prospect offer, or
 * asks for a fresh one.
 *
 * Body `{ offer, steps? }` saves the founder's text; it is never re-derived
 * after that. Body `{ regenerate: true }` writes a new one from the row's
 * research. Either way the caller regenerates the draft next, so the letter
 * opens with the offer on screen. Only a live row (pending or approved, not
 * sending) is changed.
 */
export async function queueOfferRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  if (!playMakesOffer(row.play_name)) {
    return jsonResponse({ error: `${row.play_name} makes no offer` }, 400, req);
  }

  let body: { offer?: unknown; steps?: unknown; regenerate?: unknown };
  try {
    const raw = await req.text();
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as typeof body;
  } catch {
    return jsonResponse({ error: "body must be a JSON object" }, 400, req);
  }

  let payload: Record<string, unknown>;
  try {
    const target = resolveQueueTarget(row);
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error();
    payload = target as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "row payload is not valid JSON" }, 400, req);
  }

  let offer: ProspectOffer | null;
  if (body.regenerate === true) {
    offer = await deriveOffer({ target: payload, playName: row.play_name });
    if (!offer) {
      return jsonResponse(
        { error: "No offer could be written from this row's research and the product brief." },
        422,
        req,
      );
    }
  } else {
    const text = typeof body.offer === "string" ? body.offer.trim() : "";
    if (!text) return jsonResponse({ error: "offer must be a non-empty string" }, 400, req);
    if (text.length > OFFER_MAX.offer * 2) {
      return jsonResponse({ error: `offer is over ${OFFER_MAX.offer * 2} characters` }, 400, req);
    }
    const previous = offerOf(payload);
    const steps = typeof body.steps === "string" ? body.steps.trim() : (previous?.steps ?? "");
    offer = {
      offer: text,
      steps,
      evidence: previous?.evidence ?? [],
      stage: previous?.stage ?? "",
      level: previous?.level ?? "role",
      version: OFFER_PROMPT_VERSION,
      inputHash: "founder",
      editedBy: "founder",
      derivedAt: new Date().toISOString(),
    };
  }

  if (!ledger.patchLiveQueuePayload({ id, patch: { offer } })) {
    return jsonResponse({ error: "row is no longer pending or approved" }, 409, req);
  }
  return jsonResponse({ offer }, 200, req);
}
