import { describe, expect, it } from "vitest";
import { nextOfferIndex, offerCandidatesFromPayload, offerFromPayload } from "../ProspectOffer.tsx";

describe("offerFromPayload", () => {
  it("reads the stored offer", () => {
    expect(
      offerFromPayload({
        offer: {
          offer: "do x",
          steps: "a, b",
          evidence: ["q"],
          stage: "s",
          level: "role",
          return: "cash collected",
          angles: ["why one", 3],
          editedBy: "founder",
        },
      }),
    ).toEqual({
      offer: "do x",
      steps: "a, b",
      evidence: ["q"],
      stage: "s",
      level: "role",
      return: "cash collected",
      angles: ["why one"],
      editedBy: "founder",
    });
  });
  it("reads the ranked offers, skipping unreadable ones", () => {
    const list = offerCandidatesFromPayload({
      offerCandidates: [{ offer: "first", steps: "" }, { offer: " " }, { offer: "second" }],
    });
    expect(list.map((o) => o.offer)).toEqual(["first", "second"]);
    expect(offerCandidatesFromPayload({})).toEqual([]);
  });
  it("is null without one", () => {
    expect(offerFromPayload({})).toBeNull();
    expect(offerFromPayload({ offer: { offer: " " } })).toBeNull();
    expect(offerFromPayload(null)).toBeNull();
  });
});

describe("nextOfferIndex", () => {
  const candidates = ["one", "two", "three", "four", "five"].map((offer) => ({ offer }));

  it("advances through all five candidates and wraps to the first", () => {
    expect(candidates.map((offer) => nextOfferIndex(offer, candidates))).toEqual([1, 2, 3, 4, 0]);
  });

  it("starts at the first candidate when the active offer is missing", () => {
    expect(nextOfferIndex({ offer: "old" }, candidates)).toBe(0);
    expect(nextOfferIndex(null, candidates)).toBe(0);
  });

  it("handles empty and single-candidate lists", () => {
    expect(nextOfferIndex(null, [])).toBeNull();
    expect(nextOfferIndex(candidates[0]!, candidates.slice(0, 1))).toBe(0);
  });
});
