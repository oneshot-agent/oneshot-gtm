import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RejectReasonFields,
  type RejectReasonValue,
} from "../src/components/queue/RejectReasonFields.tsx";

// The reject box asks one question (why), answered by tapping a category; the
// note is optional detail. Static render: the effects that ask the model do
// not run here, so this pins the markup the founder reads, not the calls
// (`mergeRejectSuggestion` in rejectReason.test.ts covers what a reply may
// change).

const render = (value: RejectReasonValue, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(RejectReasonFields, { rowId: 7, value, onChange: () => {}, ...props }),
  );

describe("RejectReasonFields", () => {
  it("asks why once: six categories, no second 'reason' question, no dropdown", () => {
    const html = render({ reason: "", decisionReason: "" });
    for (const label of [
      "Not our audience",
      "Wrong person",
      "Bad timing",
      "Already in touch",
      "Draft problem",
      "Other",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("<select");
    expect(html).not.toContain("No reason");
    expect(html).toContain("Note (optional");
    expect(html).toContain("Pick one, or reject without a reason.");
  });

  it("marks the picked category and says what it does", () => {
    const fit = render({ reason: "", decisionReason: "wrong_audience" });
    expect(fit).toMatch(/aria-pressed="true"[^>]*>Not our audience/);
    expect(fit).toContain("Counts as ICP evidence");

    const other = render({ reason: "", decisionReason: "already_contacted" });
    expect(other).toMatch(/aria-pressed="true"[^>]*>Already in touch/);
    expect(other).toContain("Doesn&#x27;t affect the ICP.");
  });

  it("shows one-tap detail for the picked category only", () => {
    const audience = render({ reason: "", decisionReason: "wrong_audience" });
    expect(audience).toContain("+ wrong stage");
    expect(audience).not.toContain("+ emailed before");

    const touch = render({ reason: "", decisionReason: "already_contacted" });
    expect(touch).toContain("+ emailed before");
    expect(touch).not.toContain("+ wrong stage");

    // No category, or one with nothing to add: no detail row.
    expect(render({ reason: "", decisionReason: "" })).not.toContain("Add detail");
    expect(render({ reason: "", decisionReason: "other" })).not.toContain("Add detail");
  });

  it("shows the prefilled note and where it came from", () => {
    const html = render(
      { reason: "Recruiter, not a founder.", decisionReason: "wrong_person" },
      { source: "person-gate" },
    );
    expect(html).toContain("Recruiter, not a founder.");
    expect(html).toContain("Prefilled from the ICP gate");
  });

  it("says nothing was prefilled under privacy mode", () => {
    expect(render({ reason: "", decisionReason: "" }, { privacy: true })).toContain(
      "Privacy mode — nothing prefilled.",
    );
  });
});
