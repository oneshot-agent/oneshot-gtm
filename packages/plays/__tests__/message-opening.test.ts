import { beforeEach, describe, expect, it, vi } from "vitest";

// `messageOpening: "problem"` lets an email that makes an offer open with one
// line naming the reader's problem, then the offer. Unset, every input and
// every opening check is what it was before the setting. Fictional copy.

const ws = vi.hoisted(() => ({
  opening: undefined as string | undefined,
  oneLiner: null as string | null,
}));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      productOneLiner: ws.oneLiner,
      ...(ws.opening !== undefined ? { messageOpening: ws.opening } : {}),
    }),
  };
});

import { loadPrompt } from "@oneshot-gtm/intel";
import { lintEmail, opensWithOffer } from "../src/_lib.ts";
import { PROBLEM_OPENING_LINE, withOpeningLine } from "../src/_prospect-offer.ts";

const offer = "get every vendor renewal signed before it lapses";
const problem = "I'd bet a few vendor renewals lapse every quarter before anyone signs them.";
const offerLine = "I can get every vendor renewal signed before it lapses, start to finish.";
const tail = "Your ops lead gets back the hours spent chasing them. Worth trying on the next one?";

const sameParagraph = `Hi Sam,\n\n${problem} ${offerLine} ${tail}\n\nJ`;
const ownParagraph = `Hi Sam,\n\nA question. ${problem}\n\n${offerLine} ${tail}\n\nJ`;
const offerFirst = `Hi Sam,\n\n${offerLine} ${tail}\n\nJ`;
const twoLines = `Hi Sam,\n\n${problem} Renewals pile up.\n\nThey cost money.\n\n${offerLine}\n\nJ`;

beforeEach(() => {
  ws.opening = undefined;
  ws.oneLiner = null;
});

describe("withOpeningLine", () => {
  const block = "OFFER (what you offer to do for them; the message opens with it): x";

  it("unset or offer: the block is returned unchanged", () => {
    expect(withOpeningLine(block, { offer }, {})).toBe(block);
    expect(withOpeningLine(block, { offer }, { messageOpening: "offer" })).toBe(block);
    expect(withOpeningLine(block, { offer }, { messageOpening: "Problem" })).toBe(block);
  });

  it("problem: adds the OPENING line, only when the email makes an offer", () => {
    expect(withOpeningLine(block, { offer }, { messageOpening: "problem" })).toBe(
      `${block}\n${PROBLEM_OPENING_LINE}`,
    );
    expect(PROBLEM_OPENING_LINE).toBe("OPENING: problem");
    expect(withOpeningLine(block, null, { messageOpening: "problem" })).toBe(block);
    expect(withOpeningLine(null, { offer }, { messageOpening: "problem" })).toBeNull();
  });
});

describe("opensWithOffer with a problem line first", () => {
  it("without problemFirst, only the first sentence counts", () => {
    expect(opensWithOffer(offerFirst, offer)).toBe(true);
    expect(opensWithOffer(sameParagraph, offer)).toBe(false);
    expect(opensWithOffer(ownParagraph, offer)).toBe(false);
  });

  it("with problemFirst, accepts one problem line, in its paragraph or its own", () => {
    const opts = { problemFirst: true };
    expect(opensWithOffer(offerFirst, offer, opts)).toBe(true);
    expect(opensWithOffer(sameParagraph, offer, opts)).toBe(true);
    expect(opensWithOffer(ownParagraph, offer, opts)).toBe(true);
  });

  it("with problemFirst, still refuses an offer that comes later than one problem line", () => {
    expect(opensWithOffer(twoLines, offer, { problemFirst: true })).toBe(false);
    const long = `Hi Sam,\n\n${problem} Renewals pile up. They cost money.\n\n${offerLine}\n\nJ`;
    expect(opensWithOffer(long, offer, { problemFirst: true })).toBe(false);
  });
});

describe("lintEmail opening checks under messageOpening", () => {
  const flags = (body: string) => lintEmail("vendor renewals", body, 120, undefined, { offer });

  it("unset: a problem line before the offer is opens-without-offer", () => {
    expect(flags(sameParagraph)).toContain("opens-without-offer");
    expect(flags(ownParagraph)).toContain("opens-without-offer");
    expect(flags(offerFirst)).not.toContain("opens-without-offer");
  });

  it("offer (explicit) reads as unset", () => {
    ws.opening = "offer";
    expect(flags(sameParagraph)).toContain("opens-without-offer");
  });

  it("problem: one problem line before the offer passes, more does not", () => {
    ws.opening = "problem";
    expect(flags(sameParagraph)).not.toContain("opens-without-offer");
    expect(flags(ownParagraph)).not.toContain("opens-without-offer");
    expect(flags(offerFirst)).not.toContain("opens-without-offer");
    expect(flags(twoLines)).toContain("opens-without-offer");
  });

  it("problem: an observation opener is still flagged", () => {
    ws.opening = "problem";
    const observed = `Hi Sam,\n\nI noticed your team just renewed a vendor contract. ${offerLine}\n\nJ`;
    expect(flags(observed)).toContain("opens-on-observation");
  });
});

describe("no-product-line after a problem line", () => {
  const followUp = (body: string) =>
    lintEmail("vendor renewals", body, 120, undefined, { offer, followUp: true });
  const inOffer = `Hi Sam,\n\n${problem}\n\nI can get every vendor renewal signed through Acme before it lapses. ${tail}\n\nJ`;

  it("problem: naming the product inside the offer after a problem line is not its own line", () => {
    ws.opening = "problem";
    ws.oneLiner = "Acme is an agent that signs vendor renewals";
    expect(followUp(inOffer)).not.toContain("opens-without-offer");
    expect(followUp(inOffer)).toContain("no-product-line");
    const named = inOffer.replace(
      tail,
      `Acme is an agent that chases renewals to signature. ${tail}`,
    );
    expect(followUp(named)).not.toContain("no-product-line");
  });

  it("problem: a lead-in that loosely reads as an offer does not make the real offer count", () => {
    ws.opening = "problem";
    ws.oneLiner = "Acme is an agent that signs vendor renewals";
    const loose = `Hi Sam,\n\nI could be wrong, but renewals may be taking your team too long. I can get every vendor renewal signed through Acme. Worth a look?\n\nJ`;
    expect(followUp(loose)).toContain("no-product-line");
  });

  it("problem: a product sentence after an offer-first opening still counts", () => {
    ws.opening = "problem";
    ws.oneLiner = "Acme is an agent that signs vendor renewals";
    const direct = `Hi Sam,\n\nI can get every vendor renewal signed before it lapses.\n\nAcme gets vendor renewal paperwork signed automatically.\n\nWorth a look?\n\nJ`;
    expect(followUp(direct)).not.toContain("no-product-line");
  });
});

describe("problem lines that wrap or carry an abbreviation", () => {
  const opts = { problemFirst: true };

  it("keeps a title abbreviation inside its sentence", () => {
    const titled = `Hi Sam,\n\nDr. Lee may be losing time to renewals. ${offerLine}\n\nJ`;
    expect(opensWithOffer(titled, offer, opts)).toBe(true);
  });

  it("reads a hard-wrapped two-sentence problem paragraph as one", () => {
    const wrapped = `Hi Sam,\n\n${problem}\nRenewals pile up.\n\n${offerLine}\n\nJ`;
    expect(opensWithOffer(wrapped, offer, opts)).toBe(true);
    expect(opensWithOffer(wrapped, offer)).toBe(false);
  });
});

describe("the offer-first rules", () => {
  it("describe the problem opening, bound to the OPENING line", () => {
    const rules = loadPrompt("_offer-first");
    expect(rules).toContain(
      "**Problem opening (only when the input has an `OPENING: problem` line).**",
    );
    expect(rules).toContain("Without that line, the offer is the first sentence.");
  });
});

describe("messageOpening: mixed", () => {
  const block = "OFFER (what you offer to do for them; the message opens with it): x";
  const withFigure = { messageOpening: "mixed", productBrief: "Only 47% of plans are finished." };
  const briefed = `${block}\nPRODUCT BRIEF (the only source of product claims):\nOnly 47% of plans are finished.`;
  const lineFor = (cfg: object, email: string, text = briefed) =>
    withOpeningLine(text, { offer }, cfg, { email, emailIndex: 0 });

  it("adds the line for the assigned shape, none for an offer-first email", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const out = lineFor(withFigure, `p${i}@example.test`)!;
      seen.add(out === briefed ? "none" : out.slice(briefed.length + 1));
    }
    expect([...seen].toSorted()).toEqual(
      ["OPENING: figure", "OPENING: problem", "OPENING: question", "none"].toSorted(),
    );
  });

  it("never asks for a figure the writer cannot see in its brief", () => {
    const cfg = { messageOpening: "mixed", productBrief: "We follow up with patients." };
    for (let i = 0; i < 200; i++) {
      expect(lineFor(cfg, `p${i}@example.test`, block)).not.toContain("OPENING: figure");
      // A number in the saved brief that the writer's clipped brief lost.
      expect(lineFor(withFigure, `p${i}@example.test`, block)).not.toContain("OPENING: figure");
    }
  });

  it("lets one problem line of any shape come before the offer", () => {
    ws.opening = "mixed";
    const flags = (body: string) => lintEmail("vendor renewals", body, 120, undefined, { offer });
    const question = `Hi Sam,\n\nDo vendor renewals ever lapse before anyone signs them? ${offerLine} ${tail}\n\nJ`;
    const figure = `Hi Sam,\n\nAbout 1 in 5 vendor renewals lapses before anyone signs it. ${offerLine} ${tail}\n\nJ`;
    for (const body of [question, figure, sameParagraph, offerFirst]) {
      expect(flags(body)).not.toContain("opens-without-offer");
    }
    expect(flags(twoLines)).toContain("opens-without-offer");
  });

  it("the rules describe the figure and question openings", () => {
    const rules = loadPrompt("_offer-first");
    expect(rules).toContain(
      "**Figure opening (only when the input has an `OPENING: figure` line).**",
    );
    expect(rules).toContain(
      "**Question opening (only when the input has an `OPENING: question` line).**",
    );
  });
});

describe("the question opening rule", () => {
  it("ties the question to the offer and quotes no example line to copy", () => {
    const rule = loadPrompt("_offer-first")
      .split("\n")
      .find((l) => l.startsWith("**Question opening"))!;
    expect(rule).toContain("the problem the `OFFER` solves");
    // No quoted question at all: double or single, straight or curly. A single
    // quote only opens after a space or bracket, so contractions do not count.
    const quotedQuestion = /["“][^"”]*\?["”]|(?:^|[\s(])['‘][^'’]*\?['’]/;
    expect(rule).not.toMatch(quotedQuestion);
    for (const sample of [
      'like ("Is X late?")',
      "like 'Is X late?' here",
      "like ‘Is X late?’ here",
      "like “Is X late?” here",
    ]) {
      expect(sample).toMatch(quotedQuestion);
    }
    expect("they'll ask whether it's late? no").not.toMatch(quotedQuestion);
  });
});
