import { getLedger, loadConfig, safeParseJsonRecord, type QueueRow } from "@oneshot-gtm/core";
import { CLICK_RESEARCH_WAIT_MS, offerResearchRow } from "@oneshot-gtm/find";
import {
  activeOfferPatch,
  deriveOfferSet,
  mergeKeptOffers,
  isOfferSkipped,
  isProspectOffer,
  offerCandidatesOf,
  offerProductHash,
  offerSkipPatch,
  playMakesOffer,
  type OfferSkip,
  type ProspectOffer,
} from "@oneshot-gtm/plays";
import { jsonResponse } from "../server.ts";
import {
  founderOffer,
  isOfferEditError,
  offerTarget,
  readOfferEditBody,
  selectOfferCandidate,
  weakApproval,
} from "./_offer-edit.ts";

/**
 * POST /api/queue/:id/offer: change a row's prospect offer.
 *
 * - `{ regenerate: true }` writes five new offers from the row's research,
 *   ranked by return, each a different job from the ones it replaces; the
 *   first becomes active, with its angles. When the
 *   writer declines, or none of the new offers passes the relevance check,
 *   the reason is kept on the row (`offerSkip`) and the answer is 422 with
 *   it (`offerSkip.why`). When a new one passes, the row's previous strong
 *   offers (the founder's, or passing ones of today's prompt version and
 *   product brief) follow the new ones in the candidates, up to five in all
 *   (`mergeKeptOffers`); the founder's own always stay, in place of the
 *   lowest-ranked new ones if need be. An offer the row had stays only while it stands
 *   (the founder's, approved, or a passing one of today's prompt version:
 *   `offerSkipPatch`); a weak or stale one is deleted with its candidates.
 * - `{ select: i }` makes the row's i-th offer (0-based) active, writing its
 *   angles if it has none yet.
 * - `{ offer, steps?, return? }` saves the founder's text; it is never
 *   re-derived after that. Angles are written for it.
 * - `{ approveWeak: true }` approves the active offer although the judge
 *   rated it a weak fit, releasing the send hold it puts on the row. Only
 *   that offer object carries the approval: picking another or writing new
 *   ones starts without it. 400 when the active offer is not held as weak.
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

  const body = await readOfferEditBody(req);
  if (!body) return jsonResponse({ error: "body must be a JSON object" }, 400, req);

  if (body.approveWeak === true) return approveWeakOffer(id, row.payload_json, req);
  if (body.regenerate === true) {
    const out = await regenerateQueueRowOffer(row, {
      avoidCurrent: true,
      keepStrong: true,
      researchWaitMs: CLICK_RESEARCH_WAIT_MS,
    });
    if (out === "bad-payload") {
      return jsonResponse({ error: "row payload is not valid JSON" }, 400, req);
    }
    if (out === "no-offer") {
      return jsonResponse(
        { error: "No offer could be written from this row's research and the product brief." },
        422,
        req,
      );
    }
    if (out === "not-live") {
      return jsonResponse({ error: "row is no longer pending or approved" }, 409, req);
    }
    if ("skipped" in out) {
      return jsonResponse(
        {
          error: `No offer: ${out.skipped.why || "the writer found nothing to offer."}`,
          offerSkip: out.skipped,
        },
        422,
        req,
      );
    }
    return jsonResponse(out, 200, req);
  }

  const payload = offerTarget(row);
  if (!payload) return jsonResponse({ error: "row payload is not valid JSON" }, 400, req);

  const input = { target: payload, playName: row.play_name };
  let offer: ProspectOffer;
  let candidates = offerCandidatesOf(payload);
  if (body.select !== undefined) {
    const picked = await selectOfferCandidate(candidates, body.select, input, "row");
    if (isOfferEditError(picked)) return jsonResponse({ error: picked.error }, picked.status, req);
    offer = picked.offer;
    candidates = picked.candidates;
  } else {
    const written = await founderOffer(body, input);
    if (isOfferEditError(written)) {
      return jsonResponse({ error: written.error }, written.status, req);
    }
    offer = written;
  }

  // The new offer replaces the stored one whole: an approval or judge label
  // the old one carried must not survive the JSON merge patch.
  const patch = activeOfferPatch(storedOffer(row.payload_json), offer, candidates);
  if (!ledger.patchLiveQueuePayload({ id, patch })) {
    return jsonResponse({ error: "row is no longer pending or approved" }, 409, req);
  }
  return jsonResponse({ offer, candidates }, 200, req);
}

/**
 * `{ regenerate: true }` without the HTTP: five new offers from the row's
 * research, the first active with its angles, written to the live row.
 * Shared with the read-on-open route, which rewrites the offer when a fresh
 * read moved the person's role. A writer skip is written to the row in
 * place of a set (`skipped`), leaving an offer it had only while that offer
 * stands (`offerSkipPatch`). `avoidCurrent`
 * (the founder's New offers) asks for jobs other than the row's current
 * ones, and `keepStrong` (also New offers) keeps the row's previous strong
 * offers after the new ones (`mergeKeptOffers`). The read-on-open route
 * passes neither: a moved role makes the old offers about another job. A set the judge passes none of reads the row's company research
 * first, waiting at most `researchWaitMs` (default none: the read lands on
 * the row when it finishes). The founder's click passes
 * `CLICK_RESEARCH_WAIT_MS`; the read-on-open route, which the UI awaits,
 * passes nothing.
 */
export async function regenerateQueueRowOffer(
  row: QueueRow,
  opts: { avoidCurrent?: boolean; keepStrong?: boolean; researchWaitMs?: number } = {},
): Promise<
  | { offer: ProspectOffer; candidates: ProspectOffer[] }
  | { skipped: OfferSkip }
  | "bad-payload"
  | "no-offer"
  | "not-live"
> {
  const payload = offerTarget(row);
  if (!payload) return "bad-payload";
  const avoid = opts.avoidCurrent ? currentOfferTexts(row.payload_json) : [];
  const set = await deriveOfferSet({
    target: payload,
    playName: row.play_name,
    ...(avoid.length > 0 ? { avoid } : {}),
    research: offerResearchRow(row, { researchWaitMs: opts.researchWaitMs ?? 0 }),
  });
  if (!set) return "no-offer";
  if (isOfferSkipped(set)) {
    const patch = offerSkipPatch(storedOffer(row.payload_json), set.skipped);
    if (!getLedger().patchLiveQueuePayload({ id: row.id, patch })) return "not-live";
    return { skipped: set.skipped };
  }
  const previous = storedOffer(row.payload_json);
  const candidates = opts.keepStrong
    ? mergeKeptOffers(
        set.candidates,
        previous,
        storedCandidates(row.payload_json),
        offerProductHash(loadConfig()),
      )
    : set.candidates;
  // The new offer replaces the stored one whole: an approval or judge label
  // the old one carried must not survive the JSON merge patch.
  const patch = activeOfferPatch(previous, set.offer, candidates);
  if (!getLedger().patchLiveQueuePayload({ id: row.id, patch })) return "not-live";
  return { offer: set.offer, candidates };
}

/** The row's written offers and its active one, as stored: what New offers replaces. */
function currentOfferTexts(payloadJson: string): string[] {
  const payload = safeParseJsonRecord(payloadJson);
  if (!payload) return [];
  const active = payload["offer"];
  const texts = [
    ...offerCandidatesOf(payload).map((o) => o.offer),
    ...(isProspectOffer(active) ? [active.offer] : []),
  ];
  return [...new Set(texts)];
}

/** The row's stored candidates, as written. */
function storedCandidates(payloadJson: string): ProspectOffer[] {
  const payload = safeParseJsonRecord(payloadJson);
  return payload ? offerCandidatesOf(payload) : [];
}

/** The active offer as stored on the row, before any overlay. */
function storedOffer(payloadJson: string): unknown {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["offer"]
      : null;
  } catch {
    return null;
  }
}

/** `{ approveWeak: true }`: stamp the founder's approval on the active weak offer. */
function approveWeakOffer(id: number, payloadJson: string, req: Request): Response {
  const approval = weakApproval(storedOffer(payloadJson));
  if (!approval) {
    return jsonResponse({ error: "the active offer is not rated a weak fit" }, 400, req);
  }
  const written = getLedger().patchLiveQueuePayload({
    id,
    patch: { offer: approval.stamp },
    expect: Object.entries(approval.expect).map(([key, value]) => ({
      path: `$.offer.${key}`,
      value,
    })),
  });
  if (!written) {
    return jsonResponse(
      {
        error:
          "the row is no longer pending or approved, or its offer changed; refresh and review it again",
      },
      409,
      req,
    );
  }
  return jsonResponse({ offer: approval.approved }, 200, req);
}
