/**
 * The words for an offer the writer declined to write (`OfferSkipView`),
 * shown in the offer block in place of the offer. What the founder can do
 * instead is the held draft's advice (`flagAdvice("no-offer")`). Pure.
 */
import type { OfferSkipView } from "@oneshot-gtm/shared-types";

/** "No offer: <why>." The writer's reason as one sentence. */
export function offerSkipLine(skip: Pick<OfferSkipView, "why">): string {
  const why = skip.why.trim() || "the writer found nothing to offer them";
  return `No offer: ${/[.!?]$/.test(why) ? why : `${why}.`}`;
}
