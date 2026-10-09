import { describe, expect, it } from "vitest";
import {
  appendReason,
  decisionReasonEffect,
  decisionReasonForText,
  mergeRejectSuggestion,
  reasonFromNotes,
  REJECT_DECISION_REASONS,
  REJECT_DETAIL_CHIPS,
  REJECT_REASON_CHIPS,
  suggestRejectReason,
} from "../src/lib/rejectReason.ts";

describe("suggestRejectReason", () => {
  it("prefers the person gate's reason when the verdict was reject or unclear", () => {
    expect(
      suggestRejectReason({
        payload: {
          icpVerdict: "unclear",
          icpVerdictReason: "Title is Chief of Staff, not an owner.",
        },
        notes: "auto: role — something else",
      }),
    ).toEqual({
      text: "Title is Chief of Staff, not an owner.",
      source: "person-gate",
      // The person gate judges the role: its "no" is about the person.
      decisionReason: "wrong_person",
    });
    expect(
      suggestRejectReason({
        payload: { icpVerdict: "reject", icpVerdictReason: "Sells to consumers." },
        notes: null,
      }).source,
    ).toBe("person-gate");
  });

  it("ignores the gate's reason when the verdict was pass — that sentence says why they DO fit", () => {
    const s = suggestRejectReason({
      payload: { icpVerdict: "pass", icpVerdictReason: "Founder selling B2B." },
      notes: null,
    });
    expect(s).toEqual({ text: "", source: null, decisionReason: null });
  });

  it("takes the detail row's verdict reason when the payload has none", () => {
    expect(
      suggestRejectReason({
        payload: { icpVerdict: "unclear" },
        notes: null,
        icpVerdictReason: "Role unclear from the bio.",
      }).text,
    ).toBe("Role unclear from the bio.");
  });

  it("falls back to a machine-negative note with the prefix stripped", () => {
    expect(
      suggestRejectReason({ payload: {}, notes: "auto: role — Recruiter, not a founder." }),
    ).toEqual({
      text: "Recruiter, not a founder.",
      source: "notes",
      decisionReason: "wrong_person",
    });
    // The gate named in the machine note decides the category.
    expect(
      suggestRejectReason({ payload: {}, notes: "auto: ICP — YC W26 — Consumer app, no buyer." })
        .decisionReason,
    ).toBe("wrong_audience");
    expect(
      suggestRejectReason({ payload: {}, notes: "auto: dedup — sent from another play" })
        .decisionReason,
    ).toBe("already_contacted");
    expect(
      suggestRejectReason({ payload: {}, notes: "auto: something else entirely here" })
        .decisionReason,
    ).toBeNull();
    expect(reasonFromNotes("auto: ICP — YC W26 — Consumer app, no business buyer.")).toBe(
      "Consumer app, no business buyer.",
    );
    expect(reasonFromNotes("auto: dedup — not re-sent")).toBe("not re-sent");
  });

  it("a note without the prefix is the finder's provenance, never a reason, so the dossier tier runs", () => {
    // Row #882 (2026-09-11) opened with the event name below and the LLM
    // fallback never ran; the company was ten years old.
    expect(reasonFromNotes("Bruno Faviero going to Corgi Founders Breakfast Club with Rho")).toBe(
      "",
    );
    expect(reasonFromNotes("starred langchain/langchain 3d ago — owns acquisition")).toBe("");
    expect(reasonFromNotes("Wrong segment; already spoke last year.")).toBe("");
    expect(
      suggestRejectReason({
        payload: { icpVerdict: "pass", icpVerdictReason: "Co-founder, owns acquisition" },
        notes: "Bruno Faviero going to Corgi Founders Breakfast Club with Rho",
      }),
    ).toEqual({ text: "", source: null, decisionReason: null });
  });

  it("never surfaces the gates' pass-throughs, CSV status strings, or a bare token", () => {
    expect(reasonFromNotes("auto: role — no role text available")).toBe("");
    expect(reasonFromNotes("CSV import: 12 rows")).toBe("");
    expect(reasonFromNotes("fill-the-gap enrichment returned no title")).toBe("");
    expect(reasonFromNotes("auto:")).toBe("");
    expect(reasonFromNotes("   ")).toBe("");
    expect(suggestRejectReason({ payload: null, notes: undefined })).toEqual({
      text: "",
      source: null,
      decisionReason: null,
    });
  });

  it("nothing it returns starts with the machine prefix", () => {
    for (const notes of ["auto: x — y is long enough", "AUTO: ICP — Cohort — reason text here"]) {
      expect(reasonFromNotes(notes).toLowerCase().startsWith("auto:")).toBe(false);
    }
  });
});

describe("appendReason", () => {
  it("joins with a semicolon, starts clean, and never repeats a chip", () => {
    expect(appendReason("", "wrong stage")).toBe("wrong stage");
    // The sentence's period comes off before the joiner.
    expect(appendReason("Sells to consumers.", "wrong industry")).toBe(
      "Sells to consumers; wrong industry",
    );
    expect(appendReason("wrong stage; ", "not the buyer")).toBe("wrong stage; not the buyer");
    expect(appendReason("wrong stage; not the buyer", "Not The Buyer")).toBe(
      "wrong stage; not the buyer",
    );
  });

  it("the chip list is short, lowercase and free of the machine prefix", () => {
    expect(REJECT_REASON_CHIPS.length).toBeLessThanOrEqual(8);
    for (const c of REJECT_REASON_CHIPS) {
      expect(c).toBe(c.toLowerCase());
      expect(c.startsWith("auto:")).toBe(false);
    }
  });
});

describe("the reject box's one question", () => {
  it("offers every reject reason but fit, fit judgments first, and marks which teach the ICP", () => {
    expect(REJECT_DECISION_REASONS.map((r) => [r.value, r.teachesIcp])).toEqual([
      ["wrong_audience", true],
      ["wrong_person", true],
      ["bad_timing", false],
      ["already_contacted", false],
      ["draft_problem", false],
      ["other", false],
    ]);
  });

  it("says what picking a category does", () => {
    expect(decisionReasonEffect("wrong_audience")).toMatch(/Counts as ICP evidence/);
    expect(decisionReasonEffect("already_contacted")).toBe("Doesn't affect the ICP.");
    expect(decisionReasonEffect("")).toMatch(/Pick one/);
  });

  it("places every detail chip in the category it sits under", () => {
    for (const [category, chips] of Object.entries(REJECT_DETAIL_CHIPS)) {
      for (const chip of chips ?? []) {
        expect([chip, decisionReasonForText(chip)]).toEqual([chip, category]);
      }
    }
  });

  it("names the category of the words founders actually type", () => {
    expect(decisionReasonForText("already contacted")).toBe("already_contacted");
    expect(decisionReasonForText("emailed before, no reply")).toBe("already_contacted");
    expect(decisionReasonForText("existing customer")).toBe("already_contacted");
    expect(decisionReasonForText("too big")).toBe("wrong_audience");
    expect(decisionReasonForText("B2C app")).toBe("wrong_audience");
    expect(decisionReasonForText("recruiter")).toBe("wrong_person");
    expect(decisionReasonForText("not now, mid-raise")).toBe("bad_timing");
    expect(decisionReasonForText("the draft is off")).toBe("draft_problem");
    // A relationship beats a fit word in the same sentence.
    expect(decisionReasonForText("wrong stage but already a customer")).toBe("already_contacted");
  });

  it("leaves words it can't place to the model instead of guessing", () => {
    expect(decisionReasonForText("hmm")).toBeNull();
    expect(decisionReasonForText("")).toBeNull();
    expect(decisionReasonForText(null)).toBeNull();
    // The flat list still has entries the keyword rules cover.
    expect(REJECT_REASON_CHIPS.map(decisionReasonForText)).not.toContain(null);
  });
});

describe("mergeRejectSuggestion — the founder's input always wins", () => {
  const untouched = { note: false, category: false };
  const reply = {
    reason: "Around 80 employees, Series B.",
    decisionReason: "wrong_audience",
  } as const;

  it("fills an untouched box with both answers", () => {
    expect(
      mergeRejectSuggestion({
        current: { reason: "", decisionReason: "" },
        touched: untouched,
        reply,
      }),
    ).toEqual({ reason: "Around 80 employees, Series B.", decisionReason: "wrong_audience" });
  });

  it("never replaces a note the founder wrote, but still names its category", () => {
    expect(
      mergeRejectSuggestion({
        current: { reason: "too big", decisionReason: "" },
        touched: { note: true, category: false },
        reply,
      }),
    ).toEqual({ decisionReason: "wrong_audience" });
  });

  it("never moves a category the founder tapped, and rewrites the note for it", () => {
    expect(
      mergeRejectSuggestion({
        current: { reason: "", decisionReason: "bad_timing" },
        touched: { note: false, category: true },
        reply: {
          reason: "Mid-raise; worth another look next quarter.",
          decisionReason: "bad_timing",
        },
        askedFor: "bad_timing",
      }),
    ).toEqual({ reason: "Mid-raise; worth another look next quarter." });
  });

  it("drops a reply written for a category the founder has since left", () => {
    expect(
      mergeRejectSuggestion({
        current: { reason: "", decisionReason: "wrong_person" },
        touched: { note: false, category: true },
        reply: { reason: "Mid-raise.", decisionReason: "bad_timing" },
        askedFor: "bad_timing",
      }),
    ).toEqual({});
  });

  it("keeps a category already on screen when the model suggests another", () => {
    expect(
      mergeRejectSuggestion({
        current: { reason: "", decisionReason: "wrong_person" },
        touched: untouched,
        reply,
      }),
    ).toEqual({ reason: "Around 80 employees, Series B." });
  });

  it("an empty reply changes nothing", () => {
    expect(
      mergeRejectSuggestion({
        current: { reason: "", decisionReason: "" },
        touched: untouched,
        reply: { reason: null, decisionReason: null },
      }),
    ).toEqual({});
  });
});
