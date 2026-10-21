import { describe, expect, it } from "vitest";
import type { CadenceOfferView } from "@oneshot-gtm/shared-types";
import {
  offerFlagNote,
  redraftsAfterOfferChange,
  sequenceOfferEditable,
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
  queueRowId: 12,
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

  it("is true for an active cadence with a sent row and an offer it may change", () => {
    expect(sequenceOfferEditable(card)).toBe(true);
  });

  it("is false when the first email carried it, with no sent row, mid-send or stopped", () => {
    expect(sequenceOfferEditable({ ...card, offer: view({ introCarriedOffer: true }) })).toBe(
      false,
    );
    expect(sequenceOfferEditable({ ...card, offer: view({ queueRowId: null }) })).toBe(false);
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
    expect(sequenceOfferNote(view({ queueRowId: null }))).toContain("nowhere to keep an offer");
    expect(sequenceOfferNote(view())).toBeNull();
  });

  it("points a preview held for its offer at the offer block", () => {
    expect(offerFlagNote(["no-offer"])).toContain("New offers");
    expect(offerFlagNote(["thin-body", "weak-offer"])).toContain("Approve it");
    expect(offerFlagNote(["thin-body"])).toBeNull();
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
