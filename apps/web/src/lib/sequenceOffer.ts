/**
 * The /cadences card's offer block: the offer a sequence's follow-ups
 * restate (`CadenceView.offer`), read into the queue's offer shape so both
 * pages draw it with the same block. Pure.
 */
import type { CadenceOfferChoice, CadenceOfferView, CadenceView } from "@oneshot-gtm/shared-types";
import type { OfferView } from "../components/queue/ProspectOffer.tsx";

function offerViewOf(choice: CadenceOfferChoice): OfferView {
  return {
    offer: choice.text,
    steps: choice.steps ?? "",
    evidence: choice.evidence ?? [],
    stage: choice.stage ?? "",
    level: choice.level === "role" ? "role" : "researched",
    return: choice.return ?? "",
    angles: choice.angles ?? [],
    ...(choice.fit ? { fit: choice.fit } : {}),
    ...(choice.relevance ? { relevance: choice.relevance } : {}),
    ...(choice.relevanceScore !== undefined ? { relevanceScore: choice.relevanceScore } : {}),
  };
}

/** The active offer and the ranked list, as the offer block reads them. */
export function sequenceOfferViews(view: CadenceOfferView): {
  offer: OfferView | null;
  candidates: OfferView[];
} {
  const offer =
    view.text != null
      ? {
          ...offerViewOf({ ...view, text: view.text }),
          ...(view.founderEdited ? { editedBy: "founder" as const } : {}),
          ...(view.weakApproved ? { weakApproved: true } : {}),
        }
      : null;
  return { offer, candidates: view.candidates.map(offerViewOf) };
}

/**
 * True when the founder can change the sequence's offer now: an active
 * cadence not mid-send, whose first email did not carry it.
 */
export function sequenceOfferEditable(
  c: Pick<CadenceView, "status" | "isSending" | "offer">,
): boolean {
  return c.status === "active" && !c.isSending && !!c.offer && !c.offer.introCarriedOffer;
}

/** Why the offer cannot change, in one line; null when it can (or the reason is passing, a send). */
export function sequenceOfferNote(view: CadenceOfferView): string | null {
  return view.introCarriedOffer ? "Sent with the first email, fixed for this sequence." : null;
}

/**
 * The line under a sent queue row's offer when it shows its sequence's: the
 * offer the follow-ups restate (or restated), changed on the cadence.
 */
export function sentRowSequenceOfferNote(status: CadenceView["status"]): string {
  return status === "active"
    ? "The sequence's offer: its follow-ups restate it. Change it on the cadence."
    : "The offer the sequence carried.";
}

/** True when an offer change is followed by a new draft of the next step: an email touch is next. */
export function redraftsAfterOfferChange(
  c: Pick<CadenceView, "status" | "nextStepLabel" | "nextStepChannel">,
): boolean {
  return c.status === "active" && c.nextStepLabel != null && c.nextStepChannel === "email";
}
