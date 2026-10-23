import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { clearRowActivity, setRowActivity } from "../../../lib/rowActivity.ts";
import {
  hasCompanyPagesInPayload,
  nextOfferIndex,
  offerCandidatesFromPayload,
  offerFitLabel,
  offerFromPayload,
  offerMetaTokens,
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
        { offer: "legacy without steps" },
        { offer: "second", steps: "a, b" },
      ],
    });
    // Matches the server's list, so { select: i } names the same offer.
    expect(list.map((o) => o.offer)).toEqual(["first", "second"]);
    expect(offerCandidatesFromPayload({})).toEqual([]);
  });
  it("is null without one", () => {
    expect(offerFromPayload({})).toBeNull();
    expect(offerFromPayload({ offer: { offer: " " } })).toBeNull();
    expect(offerFromPayload(null)).toBeNull();
  });
});

describe("a row the writer declined", () => {
  it("shows its reason in place of the empty note", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ProspectOffer
          rowId={1}
          payload={{}}
          editable
          skip={{ why: "They left the firm in October.", at: "2026-10-22T00:00:00.000Z" }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("No offer: They left the firm in October.");
    expect(html).not.toContain("No offer yet.");
    expect(html).toContain("Edit offer");
    expect(html).toContain("New offers");
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

  it("skips a stored candidate that is the active offer reworded", () => {
    const stored = [
      "clear pending carrier vetting backlogs by verifying motor carrier operating authority and active safety records",
      "clear pending carrier vetting backlogs by verifying motor carrier operating authority and safety records",
      "reconcile import duty rates across freight manifests",
    ].map((offer) => ({ offer }));
    expect(nextOfferIndex(stored[0]!, stored)).toBe(2);
    expect(nextOfferIndex(stored[1]!, stored)).toBe(2);
    expect(nextOfferIndex(stored[2]!, stored)).toBe(0);
    // An active offer no longer in the list skips its rewording too.
    expect(
      nextOfferIndex(
        {
          offer:
            "clear carrier vetting backlogs by verifying motor carrier operating authority and safety records",
        },
        stored.slice(1),
      ),
    ).toBe(1);
  });

  it("falls back to the next one when every other candidate repeats the active offer", () => {
    const stored = ["clear the vetting backlog", "clear the vetting backlogs"].map((offer) => ({
      offer,
    }));
    expect(nextOfferIndex(stored[0]!, stored)).toBe(1);
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

function disabledCount(html: string): number {
  return (html.match(/disabled=""/g) ?? []).length;
}

describe("offer controls while the row is busy", () => {
  const offer = { offer: "get the second site booked", steps: "a, b" };
  const payload = {
    offer,
    offerCandidates: [offer, { offer: "tidy the job sheets", steps: "a, b" }],
  };
  const editable = (p: unknown) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ProspectOffer rowId={2} payload={p} editable />
      </QueryClientProvider>,
    );

  it("locks every offer control while any offer work on the row runs", () => {
    const idle = editable(payload);
    const token = setRowActivity(2, "Switching to offer 2…");
    const busy = editable(payload);
    clearRowActivity(2, token);
    expect(disabledCount(idle)).toBe(0);
    expect(disabledCount(busy)).toBe((busy.match(/<button\b/g) ?? []).length);
    // The letter's working line names the work; the block only locks.
    expect(busy).not.toContain("Switching to offer 2…");
    expect(busy).toContain("New offers");
  });
});

/** The offer block's meta line. */
function header(html: string): string {
  return html.match(/<section[^>]*>(<div[^]*?<\/div>)/)![1]!;
}

describe("offer header", () => {
  const weak = { offer: "tidy the job sheets", steps: "a, b", level: "role", relevance: "weak" };
  const list = [weak, ...["two", "three", "four", "five"].map((offer) => ({ offer, steps: "" }))];

  it("reads index, rating, then provenance, on one line that wraps between tokens", () => {
    const html = header(render({ offer: weak, offerCandidates: list }));
    expect(html).toContain("flex-wrap");
    const tokens = [...html.matchAll(/<span class="whitespace-nowrap">([^<]*)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(tokens).toEqual(["offer 1 of 5", "· weak fit", "· from role only"]);
  });

  it("names the founder's own offer and drops the position when there is one offer", () => {
    expect(
      offerMetaTokens({ ...offerFromPayload({ offer: weak })!, editedBy: "founder" }, []),
    ).toEqual(["offer", "yours"]);
    expect(offerMetaTokens(null, [])).toEqual(["offer"]);
  });

  it("carries no activity: the letter says what is running", () => {
    const token = setRowActivity(1, "Writing 5 offers and their angles…");
    const html = render({ offer: weak, offerCandidates: list });
    clearRowActivity(1, token);
    expect(html).not.toContain("Writing 5 offers");
    expect(html).not.toContain("animate-spin");
  });
});
