import { getLedger, type CadenceWithProspect } from "@oneshot-gtm/core";
import { CLICK_RESEARCH_WAIT_MS } from "@oneshot-gtm/find";
import {
  deriveSequenceOffer,
  offerHoldsSend,
  playMakesOffer,
  prospectOfferInput,
  sequenceOfferOf,
  sequenceOfferRecord,
  withPersonResearch,
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
    ...(nonEmpty(r.writtenBy) ? { writtenBy: r.writtenBy! } : {}),
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
    ...(!o && record.skip ? { skip: { why: record.skip.why, at: record.skip.skippedAt } } : {}),
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

/** A guarded write that landed nothing with no send holding the cadence: it changed meanwhile. */
const NOT_STORED = "the sequence's offer could not be stored; refresh and retry";

/** Why a forced re-derivation stored nothing, as the route answers it. */
function noOfferResponse(
  out: Extract<DeriveSequenceOfferResult, { status: "none" }>,
  req: Request,
): Response {
  switch (out.reason) {
    case "skipped":
      // The writer read the research and declined: its reason, kept on the
      // cadence when it has no offer, is the answer.
      return jsonResponse(
        {
          error: `No offer: ${out.skip.why || "the writer found nothing to offer."}`,
          offer: cadenceOfferView(out.record),
        },
        422,
        req,
      );
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
      return jsonResponse({ error: NOT_STORED }, 409, req);
  }
}

/**
 * What a chosen or founder-written offer gets its angles from: the queue row
 * the sequence started from (its payload with the trigger's edge, without the
 * intro's offer), plus the prospect's dossier as `deriveSequenceOffer` adds
 * it; else the prospect and their dossier alone (`prospectOfferInput`).
 */
function sequenceOfferInput(
  prospectId: number,
  playName: string,
): { target: Record<string, unknown>; dossier: string | null } {
  const ledger = getLedger();
  const prospect = ledger.getProspectById(prospectId);
  const queued = ledger.cadenceQueueRow(prospectId, playName);
  const target = queued
    ? offerTarget({ payload_json: JSON.stringify(queued.payload), source: queued.source })
    : null;
  if (!target) return prospectOfferInput(prospect);
  // The row's own offer is the intro's, not the sequence's: never material.
  delete target["offer"];
  delete target["offerCandidates"];
  return withPersonResearch(target, prospect);
}

/**
 * POST /api/cadences/:id/offer?play=: change the offer a cadence's
 * follow-ups restate, kept on the cadence (`cadence_state.offer_json`,
 * through `setCadenceOffer`); no queue row changes. Same body as POST
 * /api/queue/:id/offer:
 *
 * - `{ regenerate: true }` writes new offers from the research of the queue
 *   row the sequence started from (else the prospect's) and the thread
 *   already sent (`deriveSequenceOffer`, forced). When the writer declines,
 *   422 with its reason, kept on a cadence that has no offer.
 * - `{ select: i }` makes the sequence's i-th offer active.
 * - `{ offer, steps?, return? }` saves the founder's own text.
 * - `{ approveWeak: true }` approves the active offer although it was rated
 *   a weak fit, releasing the hold it puts on the follow-up.
 *
 * A sequence with no queue row takes its research from the prospect. An
 * offer the first email carried is what was sent and never changes (409).
 * Nor does anything while a send holds the cadence: checked first, and
 * again by every write, atomically (409 either way). A change drops
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

  const record = sequenceOfferRecord({ prospectId, playName, cadence });
  if (record.introCarriedOffer) {
    return jsonResponse(
      { error: "The first email carried this offer: what was sent is fixed for this sequence." },
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
    // New offers, never the ones on screen; the firm's research is read
    // first when it is missing, for as long as a click can wait.
    const avoid = [
      ...new Set([
        ...record.offerCandidates.map((o) => o.offer),
        ...(record.offer ? [record.offer.offer] : []),
      ]),
    ];
    const out = await deriveSequenceOffer({
      prospectId,
      playName,
      force: true,
      stepIndex: cadence.current_step + 1,
      ...(avoid.length > 0 ? { avoid } : {}),
      researchWaitMs: CLICK_RESEARCH_WAIT_MS,
    });
    if (out.status === "none") {
      if (out.reason === "not-stored" && sendStarted()) {
        return jsonResponse({ error: IN_FLIGHT }, 409, req);
      }
      return noOfferResponse(out, req);
    }
    if (out.status === "existing") {
      return jsonResponse({ error: "the sequence's offer is fixed; refresh" }, 409, req);
    }
  } else {
    const input = { ...sequenceOfferInput(prospectId, playName), playName };
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
      return jsonResponse({ error: NOT_STORED }, 409, req);
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
