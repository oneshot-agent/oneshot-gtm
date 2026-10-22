import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CadenceOfferView, CadenceView } from "@oneshot-gtm/shared-types";
import { clearRowActivity, setRowActivity } from "../../../lib/rowActivity.ts";
import {
  NextSequenceOfferButton,
  SentRowSequenceOffer,
  SequenceOffer,
  sequenceOfferActivityId,
} from "../SequenceOffer.tsx";

// The cadence card's offer block: the queue's block over the sequence's
// offer, read-only once the first email carried it.

const offer = (over: Partial<CadenceOfferView> = {}): CadenceOfferView => ({
  text: "book the leeds crews into same-day slots",
  return: "same-day jobs, counted per job",
  weak: false,
  weakApproved: false,
  founderEdited: false,
  candidates: [
    { text: "book the leeds crews into same-day slots" },
    { text: "text every customer the arrival time" },
  ],
  activeIndex: 0,
  introCarriedOffer: false,
  ...over,
});

const card = (o: CadenceOfferView | undefined): CadenceView =>
  ({
    prospectId: 4,
    playName: "show-hn",
    status: "active",
    isSending: false,
    nextStepLabel: "breakup",
    nextStepChannel: "email",
    queuePayload: null,
    ...(o ? { offer: o } : {}),
  }) as CadenceView;

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

describe("SequenceOffer", () => {
  it("shows the offer with its controls, and Next offer in the letter", () => {
    const html = render(<SequenceOffer cadence={card(offer())} />);
    expect(html).toContain("book the leeds crews into same-day slots");
    expect(html).toContain("Returns: same-day jobs, counted per job");
    expect(html).toContain("· 1 of 2");
    expect(html).toContain("Edit offer");
    expect(html).toContain("New offers");
    expect(html).not.toContain("Approve offer");
    expect(render(<NextSequenceOfferButton cadence={card(offer())} />)).toContain("Next offer");
  });

  it("is read-only when the first email carried the offer", () => {
    const fixed = offer({ introCarriedOffer: true, candidates: [], activeIndex: -1 });
    const html = render(<SequenceOffer cadence={card(fixed)} />);
    expect(html).toContain("book the leeds crews into same-day slots");
    expect(html).toContain("Sent with the first email, fixed for this sequence.");
    expect(html).not.toContain("Edit offer");
    expect(html).not.toContain("New offers");
    expect(render(<NextSequenceOfferButton cadence={card(fixed)} />)).toBe("");
  });

  it("labels a weak offer and offers to approve it, until it is approved", () => {
    const weak = render(<SequenceOffer cadence={card(offer({ relevance: "weak", weak: true }))} />);
    expect(weak).toContain("· weak fit");
    expect(weak).toContain("Approve offer");
    const approved = render(
      <SequenceOffer
        cadence={card(offer({ relevance: "weak", weak: false, weakApproved: true }))}
      />,
    );
    expect(approved).toContain("weak fit, approved");
    expect(approved).not.toContain("Approve offer");
  });

  it("marks the founder's own offer, and renders nothing for a play without one", () => {
    expect(
      render(<SequenceOffer cadence={card(offer({ founderEdited: true, activeIndex: -1 }))} />),
    ).toContain("· yours");
    expect(render(<SequenceOffer cadence={card(undefined)} />)).toBe("");
  });

  it("is editable for a sequence that never had a queue row", () => {
    const html = render(<SequenceOffer cadence={card(offer({ text: null, candidates: [] }))} />);
    expect(html).toContain("No offer yet.");
    expect(html).toContain("New offers");
    expect(html).not.toContain("queue row");
  });

  it("names the offer work running on the card, keyed by the cadence", () => {
    const id = sequenceOfferActivityId(card(offer()));
    const token = setRowActivity(id, "Rewriting the draft around the offer…");
    const html = render(<SequenceOffer cadence={card(offer())} />);
    clearRowActivity(id, token);
    expect(html).toContain("Rewriting the draft around the offer…");
  });

  it("keys a cadence's work apart from any queue row and from the prospect's other plays", () => {
    const id = sequenceOfferActivityId({ prospectId: 4, playName: "show-hn" });
    expect(id).toBe("cadence:4|show-hn");
    expect(id).not.toBe(sequenceOfferActivityId({ prospectId: 4, playName: "other" }));
    // Work on queue row 4 is not the cadence's.
    const token = setRowActivity(4, "Switching to offer 2…");
    const html = render(<SequenceOffer cadence={card(offer())} />);
    clearRowActivity(4, token);
    expect(html).not.toContain("Switching to offer 2…");
  });
});

describe("SentRowSequenceOffer", () => {
  it("shows a sent row its sequence's offer, read-only", () => {
    const html = render(
      <SentRowSequenceOffer
        rowId={9}
        payload={{ offer: { offer: "the intro's old offer", steps: "" } }}
        sequence={{ status: "active", offer: offer() }}
      />,
    );
    expect(html).toContain("book the leeds crews into same-day slots");
    expect(html).not.toContain("the intro's old offer");
    expect(html).toContain("follow-ups restate it");
    expect(html).not.toContain("Edit offer");
    expect(html).not.toContain("New offers");
  });

  it("says when the sequence has no offer yet", () => {
    const html = render(
      <SentRowSequenceOffer
        rowId={9}
        payload={{}}
        sequence={{ status: "active", offer: offer({ text: null, candidates: [] }) }}
      />,
    );
    expect(html).toContain("No offer for this sequence yet.");
  });
});
