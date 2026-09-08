import { describe, expect, it } from "vitest";
import { parseProspectAngle, type ProspectAngleGroundingContext } from "../src/angle.ts";

// Schema validation + the anti-fabrication gate for issue #355's per-prospect
// angle. Every evidence claim without a real, TRACEABLE source must be
// dropped — a fabricated citation in a "grounded" artifact is worse than no
// evidence, and a citation that merely looks non-blank (but cites nothing
// the LLM was actually given) is exactly as fabricated as an empty one.

const META = { model: "test/model", synthesizedAt: "2026-09-08T00:00:00.000Z" };

/** A grounding context whose evidenceText/sourceTags cover the fixtures below. */
const GROUNDED: ProspectAngleGroundingContext = {
  evidenceText: "GITHUB (@x): ...\nhttps://github.com/x/agent-loop\nhttps://github.com/x/y",
  sourceTags: ["dossier", "github:live"],
};

/** A grounding context that covers NOTHING — every source should be rejected. */
const UNGROUNDED: ProspectAngleGroundingContext = {
  evidenceText: "(no evidence found for this prospect)",
  sourceTags: [],
};

describe("parseProspectAngle", () => {
  it("parses a well-formed angle end to end", () => {
    const angle = parseProspectAngle(
      {
        brief: "They build agent infra.",
        hook: "Shipped a new SDK release yesterday.",
        relationship: "builder",
        evidence: [{ claim: "Shipped agent-loop v2", source: "https://github.com/x/agent-loop" }],
        doNotSay: ["not building this, just researching"],
        nextStep: "Ask about their eval pipeline.",
        sources: ["dossier", "github:live"],
        valueMode: "advocate",
        buyerStage: "pre-scale",
        qualification: "small team, no funding signal yet",
      },
      META,
      GROUNDED,
    );
    expect(angle).toEqual({
      brief: "They build agent infra.",
      hook: "Shipped a new SDK release yesterday.",
      relationship: "builder",
      evidence: [{ claim: "Shipped agent-loop v2", source: "https://github.com/x/agent-loop" }],
      doNotSay: ["not building this, just researching"],
      nextStep: "Ask about their eval pipeline.",
      sources: ["dossier", "github:live"],
      valueMode: "advocate",
      buyerStage: "pre-scale",
      qualification: "small team, no funding signal yet",
      model: "test/model",
      synthesizedAt: "2026-09-08T00:00:00.000Z",
    });
  });

  it("drops an evidence entry missing a source, keeping cited entries", () => {
    const angle = parseProspectAngle(
      {
        brief: "b",
        hook: "h",
        evidence: [
          { claim: "cited claim", source: "https://github.com/x/y" },
          { claim: "uncited claim" },
          { claim: "empty source claim", source: "" },
        ],
      },
      META,
      GROUNDED,
    );
    expect(angle?.evidence).toEqual([{ claim: "cited claim", source: "https://github.com/x/y" }]);
  });

  it("drops an evidence entry missing a claim", () => {
    const angle = parseProspectAngle(
      { brief: "b", hook: "h", evidence: [{ source: "https://x.dev" }] },
      META,
      GROUNDED,
    );
    expect(angle?.evidence).toEqual([]);
  });

  it("drops a URL-shaped source that never appeared in the rendered evidence — a hallucinated citation", () => {
    const angle = parseProspectAngle(
      {
        brief: "b",
        hook: "h",
        evidence: [{ claim: "invented claim", source: "https://github.com/nobody/nothing" }],
      },
      META,
      GROUNDED,
    );
    expect(angle?.evidence).toEqual([]);
  });

  it("drops a named-tier source that was never actually gathered", () => {
    const angle = parseProspectAngle(
      {
        brief: "b",
        hook: "h",
        evidence: [{ claim: "replied twice", source: "replies:2" }],
      },
      META,
      GROUNDED, // sourceTags only has dossier/github:live — no replies tier
    );
    expect(angle?.evidence).toEqual([]);
  });

  it("drops every evidence entry when nothing was actually gathered, even with a non-blank source", () => {
    const angle = parseProspectAngle(
      {
        brief: "b",
        hook: "h",
        evidence: [
          { claim: "trust me", source: "trust me" },
          { claim: "made up", source: "https://not-real.example/profile" },
          { claim: "invented tier", source: "dossier" },
        ],
      },
      META,
      UNGROUNDED,
    );
    expect(angle?.evidence).toEqual([]);
  });

  it("keeps a named-tier source when it matches a tier that was really gathered", () => {
    const angle = parseProspectAngle(
      { brief: "b", hook: "h", evidence: [{ claim: "has a dossier", source: "dossier" }] },
      META,
      GROUNDED,
    );
    expect(angle?.evidence).toEqual([{ claim: "has a dossier", source: "dossier" }]);
  });

  it("returns null when both brief and hook are missing — nothing was actually synthesized", () => {
    expect(parseProspectAngle({ evidence: [] }, META, GROUNDED)).toBeNull();
    expect(parseProspectAngle({ brief: "", hook: "" }, META, GROUNDED)).toBeNull();
    expect(parseProspectAngle({}, META, GROUNDED)).toBeNull();
  });

  it("keeps a result when only ONE of brief/hook is present", () => {
    expect(parseProspectAngle({ brief: "b only" }, META, GROUNDED)?.brief).toBe("b only");
    expect(parseProspectAngle({ hook: "h only" }, META, GROUNDED)?.hook).toBe("h only");
  });

  it("collapses an unrecognized relationship/valueMode/buyerStage to 'unknown' rather than rejecting", () => {
    const angle = parseProspectAngle(
      {
        brief: "b",
        hook: "h",
        relationship: "acquaintance",
        valueMode: "whale",
        buyerStage: "moon",
      },
      META,
      GROUNDED,
    );
    expect(angle?.relationship).toBe("unknown");
    expect(angle?.valueMode).toBe("unknown");
    expect(angle?.buyerStage).toBe("unknown");
  });

  it("accepts every valid enum value", () => {
    for (const relationship of [
      "builder",
      "adjacent",
      "competitor",
      "user",
      "researcher",
      "unknown",
    ]) {
      expect(parseProspectAngle({ brief: "b", relationship }, META, GROUNDED)?.relationship).toBe(
        relationship,
      );
    }
    for (const valueMode of [
      "customer",
      "user",
      "design-partner",
      "advocate",
      "collaborator",
      "unknown",
    ]) {
      expect(parseProspectAngle({ brief: "b", valueMode }, META, GROUNDED)?.valueMode).toBe(
        valueMode,
      );
    }
    for (const buyerStage of [
      "at-scale",
      "funded-company",
      "pre-scale",
      "student-or-hobby",
      "unknown",
    ]) {
      expect(parseProspectAngle({ brief: "b", buyerStage }, META, GROUNDED)?.buyerStage).toBe(
        buyerStage,
      );
    }
  });

  it("rejects non-object input", () => {
    expect(parseProspectAngle(null, META, GROUNDED)).toBeNull();
    expect(parseProspectAngle("a string", META, GROUNDED)).toBeNull();
    expect(parseProspectAngle([], META, GROUNDED)).toBeNull();
    expect(parseProspectAngle(42, META, GROUNDED)).toBeNull();
  });

  it("filters non-string entries out of doNotSay/sources arrays", () => {
    const angle = parseProspectAngle(
      { brief: "b", doNotSay: ["real", 42, null, "  "], sources: ["dossier", {}, ""] },
      META,
      GROUNDED,
    );
    expect(angle?.doNotSay).toEqual(["real"]);
    expect(angle?.sources).toEqual(["dossier"]);
  });

  it("stamps model + synthesizedAt from the caller's metadata", () => {
    const angle = parseProspectAngle({ brief: "b" }, { model: "openrouter/x" }, GROUNDED);
    expect(angle?.model).toBe("openrouter/x");
    expect(typeof angle?.synthesizedAt).toBe("string");
    expect(new Date(angle!.synthesizedAt).toString()).not.toBe("Invalid Date");
  });

  it("defaults missing scalar fields to empty strings rather than undefined", () => {
    const angle = parseProspectAngle({ brief: "b" }, META, GROUNDED);
    expect(angle?.hook).toBe("");
    expect(angle?.nextStep).toBe("");
    expect(angle?.qualification).toBe("");
    expect(angle?.doNotSay).toEqual([]);
    expect(angle?.sources).toEqual([]);
    expect(angle?.evidence).toEqual([]);
  });
});
