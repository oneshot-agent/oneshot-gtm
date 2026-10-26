/**
 * Company research for an offer the writer is about to write (plays'
 * `registerOfferResearch`): an offer written mid-sequence, and a set the
 * judge passed none of. The same read a background queue row gets, within
 * the same per-row cap and the same gate (`needsCompanyResearch`).
 * Registered at module load, from the package index, so plays never imports
 * find. The dossier is written to a live queue row (a sent row keeps its
 * payload, and the read is cached for the next one). Errors, a refused
 * budget and a read past `waitMs` leave the target as it was.
 */
import { registerOfferResearch } from "@oneshot-gtm/plays";
import { researchQueueRowCompany } from "./queue-offer.ts";

registerOfferResearch(async ({ target, playName, queueRowId, source, waitMs }) => {
  const out = await researchQueueRowCompany(
    { id: queueRowId, play_name: playName, source, payload_json: JSON.stringify(target) },
    target,
    waitMs !== undefined ? { researchWaitMs: waitMs } : {},
  );
  return { target: out.payload, researched: out.researched, costUsd: out.costUsd };
});
