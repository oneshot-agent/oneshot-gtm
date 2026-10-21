/**
 * Company research for an offer written mid-sequence (plays'
 * `deriveSequenceOffer`): the same read a background queue row gets, within
 * the same per-row cap. Registered at module load, from the package index, so
 * plays never imports find. Nothing is written back to the row: a sent row
 * keeps its payload, and the read is cached for the next one. Errors and a
 * refused budget leave the target as it was.
 */
import { logEvent } from "@oneshot-gtm/core";
import { registerSequenceOfferResearch } from "@oneshot-gtm/plays";
import { researchQueueRowProduct } from "./_product-research.ts";
import { needsCompanyResearch, ROW_RESEARCH_BUDGET_USD } from "./queue-offer.ts";

registerSequenceOfferResearch(async ({ target, playName, queueRowId, source }) => {
  if (!needsCompanyResearch(playName, target)) return target;
  try {
    const out = await researchQueueRowProduct(
      {
        id: queueRowId,
        play_name: playName,
        source,
        notes: null,
        payload_json: JSON.stringify(target),
      },
      { remainingUsd: ROW_RESEARCH_BUDGET_USD },
    );
    const { dossier } = out;
    if (!out.cached && dossier.warning?.includes("cost cap reached")) return target;
    if (dossier.status === "unavailable" && target["productResearch"]) return target;
    logEvent("sequence_offer.researched", {
      queue_id: queueRowId,
      status: dossier.status,
      pages: dossier.sources.filter((s) => s.excerpt).length,
      cached: out.cached,
      cost_usd: out.costUsd,
    });
    return { ...target, productResearch: dossier };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "sequence-offer-research",
        queue_id: queueRowId,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return target;
  }
});
