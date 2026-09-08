import { describe, expect, it } from "vitest";
import { parseProspectAngle } from "../src/angle.ts";

// Schema validation + the anti-fabrication gate for issue #355's per-prospect
// angle. Every evidence claim without a real source must be dropped — a
// fabricated citation in a "grounded" artifact is worse than no evidence.

const META = { model: "test/model", synthesizedAt: "2026-09-08T00:00:00.000Z" };

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
    );
    expect(angle?.evidence).toEqual([{ claim: "cited claim", source: "https://github.com/x/y" }]);
  });

  it("drops an evidence entry missing a claim", () => {
    const angle = parseProspectAngle(
      { brief: "b", hook: "h", evidence: [{ source: "https://x.dev" }] },
      META,
    );
    expect(angle?.evidence).toEqual([]);
  });

  it("returns null when both brief and hook are missing — nothing was actually synthesized", () => {
    expect(parseProspectAngle({ evidence: [] }, META)).toBeNull();
    expect(parseProspectAngle({ brief: "", hook: "" }, META)).toBeNull();
    expect(parseProspectAngle({}, META)).toBeNull();
  });

  it("keeps a result when only ONE of brief/hook is present", () => {
    expect(parseProspectAngle({ brief: "b only" }, META)?.brief).toBe("b only");
    expect(parseProspectAngle({ hook: "h only" }, META)?.hook).toBe("h only");
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
      expect(parseProspectAngle({ brief: "b", relationship }, META)?.relationship).toBe(
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
      expect(parseProspectAngle({ brief: "b", valueMode }, META)?.valueMode).toBe(valueMode);
    }
    for (const buyerStage of [
      "at-scale",
      "funded-company",
      "pre-scale",
      "student-or-hobby",
      "unknown",
    ]) {
      expect(parseProspectAngle({ brief: "b", buyerStage }, META)?.buyerStage).toBe(buyerStage);
    }
  });

  it("rejects non-object input", () => {
    expect(parseProspectAngle(null, META)).toBeNull();
    expect(parseProspectAngle("a string", META)).toBeNull();
    expect(parseProspectAngle([], META)).toBeNull();
    expect(parseProspectAngle(42, META)).toBeNull();
  });

  it("filters non-string entries out of doNotSay/sources arrays", () => {
    const angle = parseProspectAngle(
      { brief: "b", doNotSay: ["real", 42, null, "  "], sources: ["dossier", {}, ""] },
      META,
    );
    expect(angle?.doNotSay).toEqual(["real"]);
    expect(angle?.sources).toEqual(["dossier"]);
  });

  it("stamps model + synthesizedAt from the caller's metadata", () => {
    const angle = parseProspectAngle({ brief: "b" }, { model: "openrouter/x" });
    expect(angle?.model).toBe("openrouter/x");
    expect(typeof angle?.synthesizedAt).toBe("string");
    expect(new Date(angle!.synthesizedAt).toString()).not.toBe("Invalid Date");
  });

  it("defaults missing scalar fields to empty strings rather than undefined", () => {
    const angle = parseProspectAngle({ brief: "b" }, META);
    expect(angle?.hook).toBe("");
    expect(angle?.nextStep).toBe("");
    expect(angle?.qualification).toBe("");
    expect(angle?.doNotSay).toEqual([]);
    expect(angle?.sources).toEqual([]);
    expect(angle?.evidence).toEqual([]);
  });
});
