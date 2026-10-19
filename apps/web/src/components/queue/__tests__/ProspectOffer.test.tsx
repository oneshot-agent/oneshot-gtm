import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  hasCompanyPagesInPayload,
  nextOfferIndex,
  offerCandidatesFromPayload,
  offerFitLabel,
  offerFromPayload,
  ProspectOffer,
} from "../ProspectOffer.tsx";

function render(payload: unknown): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ProspectOffer rowId={1} payload={payload} editable={false} />
    </QueryClientProvider>,
  );
}

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
      offerCandidates: [
        { offer: "first", steps: "" },
        { offer: " ", steps: "" },
        { offer: "missing steps" },
        { offer: "numeric steps", steps: 42 },
        { offer: "null steps", steps: null },
        { offer: "second", steps: "a, b" },
      ],
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

describe("offer relevance in the case", () => {
  const active = {
    offer: "get the second site booked",
    steps: "a, b",
    return: "jobs kept",
    fit: "their firm: a second site booked by hand",
    relevance: "relevant",
    relevanceScore: 0.83,
  };
  const weak = {
    offer: "tidy the job sheets",
    steps: "a, b",
    relevance: "weak",
    relevanceScore: 0.31,
  };
  const pages = {
    productResearch: { sources: [{ url: "https://alpha.example", excerpt: "Alpha books jobs" }] },
  };

  it("reads fit, label and score", () => {
    expect(offerFromPayload({ offer: active })).toMatchObject({
      fit: active.fit,
      relevance: "relevant",
      relevanceScore: 0.83,
    });
    expect(offerFromPayload({ offer: { offer: "x", relevance: "nonsense" } })).not.toHaveProperty(
      "relevance",
    );
  });

  it("scores out of five, or names the label when there is no score", () => {
    expect(offerFitLabel({ relevanceScore: 0.83 })).toBe("fit 4/5");
    expect(offerFitLabel({ relevanceScore: 1 })).toBe("fit 5/5");
    expect(offerFitLabel({ relevance: "relevant" })).toBe("relevant");
    expect(offerFitLabel({})).toBeNull();
  });

  it("shows the active offer's fit line and each listed offer's score and weak tag", () => {
    const html = render({ ...pages, offer: active, offerCandidates: [active, weak] });
    expect(html).toContain("Fit: their firm: a second site booked by hand");
    expect(html).toContain("fit 2/5 · weak fit");
    expect(html).not.toContain("written without the company");
  });

  it("notes an offer written without the company's own pages", () => {
    expect(hasCompanyPagesInPayload(pages)).toBe(true);
    expect(hasCompanyPagesInPayload({ productResearch: { sources: [{ url: "u" }] } })).toBe(false);
    expect(render({ offer: active })).toContain("written without the company&#x27;s site");
  });

  it("tags a weak active offer", () => {
    expect(render({ ...pages, offer: weak })).toContain("· weak fit");
  });
});
