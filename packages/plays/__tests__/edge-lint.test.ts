import { describe, expect, it } from "vitest";
import { describeEdgeWarning, lintEdge } from "../src/_edge-lint.ts";

// Issue #585: a warn-tier read of the edge. Never a refusal — "x" must lint
// to warnings, not throw, because it is a fixture across the suite.

const GOOD = [
  "For a founder selling to clinics and contractors — the data breaks before the copy does: email-finding tools trained on tech companies hand back info@ or nothing. What we found: resolve a named person off the listing first.",
  "For someone in a marketing or growth role, outbound dies on the second touch: the follow-up re-sends the first argument with a bump on top. What we found: a follow-up built on one new fact gets read.",
  "When the buyers are engineers, the product ships in a weekend and dies in the first hundred emails, because the same message goes to everyone. What we found: the channel was the variable, not the copy.",
].join(" // ");

describe("lintEdge", () => {
  it("says nothing about a well-shaped multi-angle edge", () => {
    expect(lintEdge(GOOD)).toEqual([]);
  });

  it("flags a single flat angle and a fixture-sized one without throwing", () => {
    expect(lintEdge("x")).toContain("single-angle");
    expect(lintEdge("x")).toContain("angle-too-short:1");
    expect(lintEdge("")).toEqual([]);
    expect(lintEdge(null)).toEqual([]);
  });

  it("flags an angle with no routing clause, numbered", () => {
    const w = lintEdge(
      `${GOOD} // The join between sequencer and inbox is a spreadsheet you keep by hand, and nobody owns it.`,
    );
    expect(w).toContain("no-routing-clause:4");
    expect(w).not.toContain("no-routing-clause:1");
  });

  it("flags the landing-page shape the strategist used to write", () => {
    const w = lintEdge(
      "OneShot GTM connects prospect discovery, research, outreach review, follow-ups, and replies in one workspace, so a founder or lean team can run customer acquisition with less manual coordination.",
    );
    expect(w).toContain("reads-as-pitch:1");
    expect(w).toContain("no-routing-clause:1");
    expect(w).toContain("single-angle");
  });

  it("carries the banned-copy vocabulary from the email linter", () => {
    const w = lintEdge(
      `${GOOD} // For a founder who wants a seamless, robust workflow — worth a 10-min back-and-forth on it.`,
    );
    expect(w.some((x) => x.startsWith("slop:ai-vocab:4"))).toBe(true);
    expect(w.some((x) => x.startsWith("slop:banned-cta:worth-n-min:4"))).toBe(true);
  });
});

describe("describeEdgeWarning", () => {
  it("renders each kind as a founder-facing sentence with the angle number", () => {
    expect(describeEdgeWarning("single-angle")).toContain("one angle only");
    expect(describeEdgeWarning("angle-too-short:2")).toContain("angle 2");
    expect(describeEdgeWarning("no-routing-clause:3")).toContain("angle 3");
    expect(describeEdgeWarning("reads-as-pitch:1")).toContain("landing page");
    expect(describeEdgeWarning("slop:banned-cta:worth-n-min:4")).toBe(
      "angle 4 uses banned copy (banned-cta:worth-n-min)",
    );
  });
});
