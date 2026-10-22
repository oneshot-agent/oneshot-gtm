import { getLedger, type CadenceWithProspect } from "@oneshot-gtm/core";
import {
  deriveSequenceOffer,
  offerHoldsSend,
  playMakesOffer,
  sequenceOfferOf,
  sequenceOfferRecord,
  writeSequenceOffer,
  type DeriveSequenceOfferResult,
  type ProspectOffer,
  type SequenceOfferRecord,
  type SequenceOfferValue,
} from "@oneshot-gtm/plays";
import type { CadenceOfferChoice, CadenceOfferView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import {
  founderOffer,
  isOfferEditError,
  offerTarget,
  readOfferEditBody,
  selectOfferCandidate,
  weakApproval,
} from "./_offer-edit.ts";

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** One stored offer as the card reads it: only the fields it shows. */
function offerChoice(o: SequenceOfferValue | ProspectOffer): CadenceOfferChoice {
  const r = o as Partial<ProspectOffer>;
  const angles = strings(r.angles);
  const evidence = strings(r.evidence);
  const ret = nonEmpty(r.return);
  const steps = nonEmpty(r.steps);
  const stage = nonEmpty(r.stage);
  const fit = nonEmpty(r.fit);
  return {
    text: o.offer,
    ...(ret ? { return: ret } : {}),
    ...(steps ? { steps } : {}),
    ...(angles ? { angles } : {}),
    ...(evidence ? { evidence } : {}),
    ...(stage ? { stage } : {}),
    ...(r.level === "role" || r.level === "researched" ? { level: r.level } : {}),
    ...(fit ? { fit } : {}),
    ...(r.relevance === "relevant" || r.relevance === "weak" || r.relevance === "irrelevant"
      ? { relevance: r.relevance }
      : {}),
    ...(typeof r.relevanceScore === "number" && Number.isFinite(r.relevanceScore)
      ? { relevanceScore: r.relevanceScore }
      : {}),
  };
}

/**
 * The cadence card's offer block, from the sequence's offer record. Reads
 * only what the record holds: no model or network call, so the list can
 * build one per active row.
 */
export function cadenceOfferView(record: SequenceOfferRecord): CadenceOfferView {
  const o = record.offer;
  const active = o ? offerChoice(o) : null;
  const founderEdited = o?.editedBy === "founder";
  return {
    ...active,
    text: active?.text ?? null,
    weak: o ? offerHoldsSend(o) : false,
    weakApproved:
      o?.relevance === "weak" && !founderEdited && typeof o.weakApprovedAt === "string"
        ? o.weakApprovedAt.trim().length > 0
        : false,
    founderEdited,
    candidates: record.offerCandidates.map(offerChoice),
    // The founder's own text is none of the written ones, whatever it says.
    activeIndex:
      o && !founderEdited ? record.offerCandidates.findIndex((c) => c.offer === o.offer) : -1,
    introCarriedOffer: record.introCarriedOffer,
    queueRowId: record.queueRowId,
  };
}

/** The offer view for a cadence row, from the row itself, when the play makes one; never throws. */
export function cadenceOfferFor(
  cadence: Pick<CadenceWithProspect, "prospect_id" | "play_name" | "offer_json" | "queue_id">,
): CadenceOfferView | undefined {
  if (!playMakesOffer(cadence.play_name)) return undefined;
  return cadenceOfferView(sequenceOfferOf(cadence));
}

const IN_FLIGHT = "cadence send is already in flight; wait for it to finish";

/** Why a forced re-derivation stored nothing, as the route answers it. */
function noOfferResponse(
  reason: Extract<DeriveSequenceOfferResult, { status: "none" }>["reason"],
  req: Request,
): Response {
  switch (reason) {
    case "no-brief":
      return jsonResponse({ error: "No offer can be written without a product brief." }, 422, req);
    case "nothing-derived":
      return jsonResponse(
        {
          error:
            "No offer could be written from this sequence's research, the thread and the product brief.",
        },
        422,
        req,
      );
    case "no-play-offer":
      return jsonResponse({ error: "this play makes no offer" }, 400, req);
    case "error":
      return jsonResponse({ error: "writing the offers failed; try again" }, 500, req);
    default:
      return jsonResponse(
        { error: "the sequence's sent row could not be written; refresh and retry" },
        409,
        req,
      );
  }
}

/**
 * POST /api/cadences/:id/offer?play=: change the offer a cadence's
 * follow-ups restate, kept on the sent queue row its intro went out from.
 * Same body as POST /api/queue/:id/offer:
 *
 * - `{ regenerate: true }` writes new offers from the row's research and the
 *   thread already sent (`deriveSequenceOffer`, forced).
 * - `{ select: i }` makes the sequence's i-th offer active.
 * - `{ offer, steps?, return? }` saves the founder's own text.
 * - `{ approveWeak: true }` approves the active offer although it was rated
 *   a weak fit, releasing the hold it puts on the follow-up.
 *
 * An offer the first email carried is what was sent and never changes
 * (409). Nor does anything while a send holds the cadence: checked first,
 * and again by every write, atomically (409 either way). A change drops
 * the stored preview (its version closed as `regenerate`, as a founder's
 * regenerate would), so the next draft restates the new offer; the caller
 * drafts it, as after the queue's offer change. Answers the offer as the
 * card shows it.
 */
export async function cadenceOfferRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const prospectId = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(prospectId)) return jsonResponse({ error: "bad id" }, 400, req);
  const playName = new URL(req.url).searchParams.get("play") ?? "";
  if (!playName) return jsonResponse({ error: "play query param required" }, 400, req);
  const ledger = getLedger();
  const cadence = ledger.getCadence(prospectId, playName);
  if (!cadence) return jsonResponse({ error: "cadence not found" }, 404, req);
  if (cadence.status !== "active") {
    return jsonResponse({ error: `cadence is already ${cadence.status}` }, 409, req);
  }
  if (cadence.sending_started_at) return jsonResponse({ error: IN_FLIGHT }, 409, req);
  if (!playMakesOffer(playName)) {
    return jsonResponse({ error: `${playName} makes no offer` }, 400, req);
  }
  const body = await readOfferEditBody(req);
  if (!body) return jsonResponse({ error: "body must be a JSON object" }, 400, req);

  const record = sequenceOfferRecord({ prospectId, playName });
  if (record.introCarriedOffer) {
    return jsonResponse(
      { error: "The first email carried this offer: what was sent is fixed for this sequence." },
      409,
      req,
    );
  }
  if (record.queueRowId == null) {
    return jsonResponse(
      { error: "This sequence has no sent queue row to keep an offer on." },
      409,
      req,
    );
  }
  // Every write lands only while no send holds the cadence, in the same
  // statement (`setCadenceOffer`): the model calls below take a while, and a
  // send that claimed the cadence meanwhile wins.
  const sendStarted = (): boolean => !!ledger.getCadence(prospectId, playName)?.sending_started_at;

  if (body.approveWeak === true) {
    const approval = weakApproval(record.offer);
    if (!approval) {
      return jsonResponse({ error: "the active offer is not rated a weak fit" }, 400, req);
    }
    const written = writeSequenceOffer({
      record,
      offer: approval.stamp,
      merge: true,
      expect: approval.expect,
    });
    if (!written) {
      if (sendStarted()) return jsonResponse({ error: IN_FLIGHT }, 409, req);
      return jsonResponse(
        { error: "the sequence's offer changed; refresh and review it again" },
        409,
        req,
      );
    }
  } else if (body.regenerate === true) {
    const out = await deriveSequenceOffer({
      prospectId,
      playName,
      force: true,
      stepIndex: cadence.current_step + 1,
    });
    if (out.status === "none") {
      if (out.reason === "not-stored" && sendStarted()) {
        return jsonResponse({ error: IN_FLIGHT }, 409, req);
      }
      return noOfferResponse(out.reason, req);
    }
    if (out.status === "existing") {
      return jsonResponse({ error: "the sequence's offer is fixed; refresh" }, 409, req);
    }
  } else {
    const row = ledger.getQueueRow(record.queueRowId);
    const target = row ? offerTarget(row) : null;
    if (!target) {
      return jsonResponse({ error: "the sequence's sent row payload is not valid JSON" }, 400, req);
    }
    const input = { target, playName };
    let offer: ProspectOffer;
    let candidates: ProspectOffer[] | undefined;
    if (body.select !== undefined) {
      const picked = await selectOfferCandidate(
        record.offerCandidates,
        body.select,
        input,
        "sequence",
      );
      if (isOfferEditError(picked)) {
        return jsonResponse({ error: picked.error }, picked.status, req);
      }
      offer = picked.offer;
      candidates = picked.candidates;
    } else {
      const written = await founderOffer(body, input);
      if (isOfferEditError(written)) {
        return jsonResponse({ error: written.error }, written.status, req);
      }
      offer = written;
    }
    // Replaces the stored offer whole: an approval or judge label the old
    // one carried does not survive. The founder's text keeps the list.
    const written = writeSequenceOffer({
      record,
      offer,
      ...(candidates ? { offerCandidates: candidates } : {}),
    });
    if (!written) {
      if (sendStarted()) return jsonResponse({ error: IN_FLIGHT }, 409, req);
      return jsonResponse(
        { error: "the sequence's sent row could not be written; refresh and retry" },
        409,
        req,
      );
    }
  }

  // The stored preview restates the old offer, or was held for it.
  const previewDiscarded = ledger.discardCadenceDraft({
    prospectId,
    playName,
    reason: "regenerate",
  });
  return jsonResponse(
    {
      offer: cadenceOfferView(sequenceOfferRecord({ prospectId, playName })),
      previewDiscarded,
    },
    200,
    req,
  );
}
