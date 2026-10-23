/**
 * The words for an offer the writer declined to write (`OfferSkipView`):
 * its reason, and what the founder can do instead. Regenerating the draft
 * asks nothing new of the writer, so it is never offered. Pure.
 */
import type { OfferSkipView } from "@oneshot-gtm/shared-types";

/** "No offer: <why>." The writer's reason as one sentence. */
export function offerSkipLine(skip: Pick<OfferSkipView, "why">): string {
  const why = skip.why.trim() || "the writer found nothing to offer them";
  return `No offer: ${/[.!?]$/.test(why) ? why : `${why}.`}`;
}

/** The choices left, for a sequence's follow-up or a queue row's intro. */
export function offerSkipChoices(owner: "sequence" | "row"): string {
  return `Regenerating will not change this. Write the offer yourself (Edit offer), ask for New offers, or ${
    owner === "sequence" ? "stop the sequence" : "reject the row"
  }.`;
}
