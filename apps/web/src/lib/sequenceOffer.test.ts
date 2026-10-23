import { describe, expect, it } from "vitest";
import type { CadenceOfferView } from "@oneshot-gtm/shared-types";
import {
  redraftsAfterOfferChange,
  sequenceOfferEditable,
  sentRowSequenceOfferNote,
  sequenceOfferNote,
  sequenceOfferViews,
} from "./sequenceOffer.ts";

// The cadence card's offer block reads the sequence's offer in the queue's
// shape, and can change it only while nothing fixed or in flight holds it.

const view = (over: Partial<CadenceOfferView> = {}): CadenceOfferView => ({
  text: "book the leeds crews into same-day slots",
  return: "same-day jobs, counted per job",
  angles: ["one"],
  relevance: "weak",
  weak: true,
  weakApproved: false,
  founderEdited: false,
  candidates: [
    { text: "book the leeds crews into same-day slots", relevance: "weak" },
    { text: "text every customer the arrival time", relevanceScore: 0.8 },
  ],
  activeIndex: 0,
  introCarriedOffer: false,
  ...over,
});

describe("sequenceOfferViews", () => {
  it("reads the active offer and the list in the queue's shape", () => {
    const { offer, candidates } = sequenceOfferViews(view());
    expect(offer).toMatchObject({
      offer: "book the leeds crews into same-day slots",
      return: "same-day jobs, counted per job",
      angles: ["one"],
      steps: "",
      evidence: [],
      relevance: "weak",
    });
    expect(offer?.editedBy).toBeUndefined();
    expect(candidates.map((c) => c.offer)).toEqual([
      "book the leeds crews into same-day slots",
      "text every customer the arrival time",
    ]);
    expect(candidates[1]?.relevanceScore).toBe(0.8);
  });

  it("marks the founder's text and an approval, and reads no offer as none", () => {
    expect(sequenceOfferViews(view({ founderEdited: true })).offer?.editedBy).toBe("founder");
    expect(sequenceOfferViews(view({ weakApproved: true })).offer?.weakApproved).toBe(true);
    expect(sequenceOfferViews(view({ text: null, candidates: [] }))).toEqual({
      offer: null,
      candidates: [],
    });
  });
});

describe("sequenceOfferEditable", () => {
  const card = { status: "active" as const, isSending: false, offer: view() };

  it("is true for an active cadence with an offer it may change, queue row or not", () => {
    expect(sequenceOfferEditable(card)).toBe(true);
    expect(sequenceOfferEditable({ ...card, offer: view({ text: null, candidates: [] }) })).toBe(
      true,
    );
  });

  it("is false when the first email carried it, mid-send or stopped", () => {
    expect(sequenceOfferEditable({ ...card, offer: view({ introCarriedOffer: true }) })).toBe(
      false,
    );
    expect(sequenceOfferEditable({ ...card, isSending: true })).toBe(false);
    expect(sequenceOfferEditable({ ...card, status: "stopped" })).toBe(false);
    expect(sequenceOfferEditable({ status: "active", isSending: false })).toBe(false);
  });
});

describe("notes", () => {
  it("says why an offer cannot change", () => {
    expect(sequenceOfferNote(view({ introCarriedOffer: true }))).toBe(
      "Sent with the first email, fixed for this sequence.",
    );
    expect(sequenceOfferNote(view())).toBeNull();
    expect(sequenceOfferNote(view({ text: null, candidates: [] }))).toBeNull();
  });

  it("says a sent row's offer is its sequence's, changed on the cadence while it runs", () => {
    expect(sentRowSequenceOfferNote("active")).toContain("follow-ups restate it");
    expect(sentRowSequenceOfferNote("active")).toContain("on the cadence");
    expect(sentRowSequenceOfferNote("completed")).toBe("The offer the sequence carried.");
  });

  it("redrafts after a change only when an email is next", () => {
    const next = { status: "active" as const, nextStepLabel: "breakup" };
    expect(redraftsAfterOfferChange({ ...next, nextStepChannel: "email" })).toBe(true);
    expect(redraftsAfterOfferChange({ ...next, nextStepChannel: "direct_mail" })).toBe(false);
    expect(
      redraftsAfterOfferChange({ ...next, nextStepLabel: null, nextStepChannel: "email" }),
    ).toBe(false);
  });
});
