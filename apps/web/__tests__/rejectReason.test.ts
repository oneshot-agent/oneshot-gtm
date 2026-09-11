import { describe, expect, it } from "vitest";
import {
  appendReason,
  reasonFromNotes,
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
    ).toEqual({ text: "Title is Chief of Staff, not an owner.", source: "person-gate" });
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
    expect(s).toEqual({ text: "", source: null });
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

  it("falls back to the finder's note with the machine prefix stripped", () => {
    expect(
      suggestRejectReason({ payload: {}, notes: "auto: role — Recruiter, not a founder." }),
    ).toEqual({
      text: "Recruiter, not a founder.",
      source: "notes",
    });
    expect(reasonFromNotes("auto: ICP — YC W26 — Consumer app, no business buyer.")).toBe(
      "Consumer app, no business buyer.",
    );
    expect(reasonFromNotes("auto: dedup — not re-sent")).toBe("not re-sent");
    expect(reasonFromNotes("Wrong segment; already spoke last year.")).toBe(
      "Wrong segment; already spoke last year.",
    );
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
