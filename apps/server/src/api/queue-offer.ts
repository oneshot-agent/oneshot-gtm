import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { resolveQueueTarget } from "@oneshot-gtm/find";
import {
  deriveOfferSet,
  OFFER_MAX,
  OFFER_PROMPT_VERSION,
  offerCandidatesOf,
  playMakesOffer,
  withOfferAngles,
  type ProspectOffer,
} from "@oneshot-gtm/plays";
import { jsonResponse } from "../server.ts";

/**
 * POST /api/queue/:id/offer: change a row's prospect offer.
 *
 * - `{ regenerate: true }` writes five new offers from the row's research,
 *   ranked by return; the first becomes active, with its angles.
 * - `{ select: i }` makes the row's i-th offer (0-based) active, writing its
 *   angles if it has none yet.
 * - `{ offer, steps?, return? }` saves the founder's text; it is never
 *   re-derived after that. Angles are written for it.
 *
 * Either way the caller regenerates the draft next, so the letter opens with
 * the offer on screen. Only a live row (pending or approved, not sending) is
 * changed.
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

  let body: {
    offer?: unknown;
    steps?: unknown;
    return?: unknown;
    regenerate?: unknown;
    select?: unknown;
  };
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
    // The trigger's edge, not the current offer's angles: new angles take the
    // founder's as material.
    const target = resolveQueueTarget(row, { offerAngles: false });
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error();
    payload = target as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "row payload is not valid JSON" }, 400, req);
  }

  const input = { target: payload, playName: row.play_name };
  let offer: ProspectOffer;
  let candidates = offerCandidatesOf(payload);
  if (body.regenerate === true) {
    const set = await deriveOfferSet(input);
    if (!set) {
      return jsonResponse(
        { error: "No offer could be written from this row's research and the product brief." },
        422,
        req,
      );
    }
    offer = set.offer;
    candidates = set.candidates;
  } else if (body.select !== undefined) {
    const index = typeof body.select === "number" ? body.select : Number.NaN;
    const chosen = Number.isInteger(index) ? candidates[index] : undefined;
    if (!chosen) {
      return jsonResponse({ error: `no offer #${String(body.select)} on this row` }, 400, req);
    }
    offer = chosen.angles?.length ? chosen : await withOfferAngles(chosen, input);
    candidates = candidates.map((c, i) => (i === index ? offer : c));
  } else {
    const text = typeof body.offer === "string" ? body.offer.trim() : "";
    if (!text) return jsonResponse({ error: "offer must be a non-empty string" }, 400, req);
    if (text.length > OFFER_MAX.offer * 2) {
      return jsonResponse({ error: `offer is over ${OFFER_MAX.offer * 2} characters` }, 400, req);
    }
    // Same rule as a written offer: none without a brief to ground it.
    if (!loadConfig().productBrief?.trim()) {
      return jsonResponse({ error: "No offer can be used without a product brief." }, 422, req);
    }
    const ret = typeof body.return === "string" ? body.return.trim() : "";
    if (ret.length > OFFER_MAX.return * 2) {
      return jsonResponse({ error: `return is over ${OFFER_MAX.return * 2} characters` }, 400, req);
    }
    // The old offer's steps and evidence were reasoning for a different
    // offer; the founder's text stands on its own unless they give steps.
    offer = await withOfferAngles(
      {
        offer: text,
        steps: typeof body.steps === "string" ? body.steps.trim() : "",
        evidence: [],
        stage: "",
        level: "role",
        ...(ret ? { return: ret } : {}),
        version: OFFER_PROMPT_VERSION,
        inputHash: "founder",
        editedBy: "founder",
        derivedAt: new Date().toISOString(),
      },
      input,
    );
  }

  if (!ledger.patchLiveQueuePayload({ id, patch: { offer, offerCandidates: candidates } })) {
    return jsonResponse({ error: "row is no longer pending or approved" }, 409, req);
  }
  return jsonResponse({ offer, candidates }, 200, req);
}
