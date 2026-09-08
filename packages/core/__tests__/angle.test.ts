import { describe, expect, it } from "vitest";
import {
  angleBlockFromJson,
  parseProspectAngle,
  type ProspectAngleGroundingContext,
} from "../src/angle.ts";

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

  it("keeps a 'dossier' citation when only 'dossier:live' was gathered — the prompt's own example cites the tier as 'dossier' either way (issue #569)", () => {
    const liveOnly: ProspectAngleGroundingContext = {
      evidenceText: "DOSSIER:\nfresh research payload",
      sourceTags: ["dossier:live"],
    };
    const angle = parseProspectAngle(
      { brief: "b", hook: "h", evidence: [{ claim: "has a dossier", source: "dossier" }] },
      META,
      liveOnly,
    );
    expect(angle?.evidence).toEqual([{ claim: "has a dossier", source: "dossier" }]);
  });

  it("still rejects 'dossier' when neither 'dossier' nor 'dossier:live' was gathered", () => {
    const angle = parseProspectAngle(
      { brief: "b", hook: "h", evidence: [{ claim: "has a dossier", source: "dossier" }] },
      META,
      UNGROUNDED,
    );
    expect(angle?.evidence).toEqual([]);
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

  it("drops a top-level sources[] tier that was never actually gathered — a hallucinated tier name is not persisted as fact (issue #569)", () => {
    const angle = parseProspectAngle(
      { brief: "b", sources: ["dossier", "webread", "replies:3"] },
      META,
      GROUNDED, // sourceTags only has dossier/github:live — webread and replies:3 were never gathered
    );
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

// angleBlockFromJson — issue #356's guarded, read-only ANGLE block. Every
// caller (cadence follow-up, reply, outbound) shares this renderer, so its
// contract is tested once here rather than duplicated per call site.
describe("angleBlockFromJson", () => {
  it("returns null for null/undefined/blank input — the missing-angle case that must change nothing", () => {
    expect(angleBlockFromJson(null)).toBeNull();
    expect(angleBlockFromJson(undefined)).toBeNull();
    expect(angleBlockFromJson("")).toBeNull();
    expect(angleBlockFromJson("   ")).toBeNull();
  });

  it("returns null for unparsable JSON", () => {
    expect(angleBlockFromJson("not json")).toBeNull();
    expect(angleBlockFromJson("{broken")).toBeNull();
  });

  it("returns null for a non-object JSON value", () => {
    expect(angleBlockFromJson("42")).toBeNull();
    expect(angleBlockFromJson("null")).toBeNull();
    expect(angleBlockFromJson("[]")).toBeNull();
    expect(angleBlockFromJson('"a string"')).toBeNull();
  });

  it("returns null when every field is empty — an all-null shell must not render a block", () => {
    expect(angleBlockFromJson(JSON.stringify({ hook: "", doNotSay: [], nextStep: "" }))).toBeNull();
    expect(angleBlockFromJson(JSON.stringify({}))).toBeNull();
  });

  it("renders the Hook line when present", () => {
    const block = angleBlockFromJson(JSON.stringify({ hook: "Shipped agent-loop v2 yesterday." }));
    expect(block).toContain("ANGLE");
    expect(block).toContain("Hook: Shipped agent-loop v2 yesterday.");
  });

  it("renders every doNotSay entry under a binding label", () => {
    const block = angleBlockFromJson(
      JSON.stringify({ doNotSay: ["not building this, just researching", "not the buyer"] }),
    );
    expect(block).toContain("Do NOT say");
    expect(block).toContain("- not building this, just researching");
    expect(block).toContain("- not the buyer");
  });

  it("renders nextStep and up to maxEvidence evidence entries", () => {
    const block = angleBlockFromJson(
      JSON.stringify({
        hook: "h",
        nextStep: "Ask about their eval pipeline.",
        evidence: [
          { claim: "Shipped agent-loop v2", source: "https://github.com/x/agent-loop" },
          { claim: "Replied twice", source: "replies:2" },
          { claim: "third", source: "dossier" },
          { claim: "fourth, should be dropped by default cap", source: "github:live" },
        ],
      }),
    );
    expect(block).toContain("Next step: Ask about their eval pipeline.");
    expect(block).toContain("Shipped agent-loop v2 (https://github.com/x/agent-loop)");
    expect(block).toContain("Replied twice (replies:2)");
    expect(block).toContain("third (dossier)");
    expect(block).not.toContain("fourth, should be dropped");
  });

  it("drops an evidence entry missing a claim or source", () => {
    const block = angleBlockFromJson(
      JSON.stringify({
        hook: "h",
        evidence: [
          { claim: "no source" },
          { source: "no-claim" },
          { claim: "ok", source: "dossier" },
        ],
      }),
    );
    expect(block).toContain("ok (dossier)");
    expect(block).not.toContain("no source");
    expect(block).not.toContain("no-claim");
  });

  it("respects a caller-supplied maxEvidence", () => {
    const block = angleBlockFromJson(
      JSON.stringify({
        hook: "h",
        evidence: [
          { claim: "one", source: "dossier" },
          { claim: "two", source: "dossier" },
        ],
      }),
      { maxEvidence: 1 },
    );
    expect(block).toContain("one (dossier)");
    expect(block).not.toContain("two (dossier)");
  });
});
