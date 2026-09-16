import { describe, expect, it } from "vitest";
import { WORKSPACE_SPECIFIC_PAYLOAD_KEYS, portableQueuePayload } from "../src/queue-portable.ts";

// What a "move to workspace X" carries: the person and the research, never
// the sender's positioning or the verdicts written against the source ICP.

describe("portableQueuePayload", () => {
  it("drops exactly the workspace-specific keys and keeps everything else", () => {
    const payload = {
      name: "Ada",
      email: "ada@example.com",
      company: "Analytical",
      linkedinUrl: "https://linkedin.com/in/ada",
      personResearch: { status: "ok", summary: "…" },
      productResearch: { oneLiner: "engines" },
      cohort: "yc-s26",
      postTitle: "Show HN: engines",
      businessAddress: { line1: "1 Main" },
      titleAtFinder: "CTO",
      yourEdge: "For a founder — the stack breaks // For a CTO — egress",
      yourClaim: "claim",
      fitReason: "fits because",
      fitReasonSource: "llm",
      icpVerdict: "reject",
      icpVerdictReason: "off ICP",
      angle: { text: "x" },
      emailOverride: "other@example.com",
    };
    const out = portableQueuePayload(payload)!;
    for (const key of WORKSPACE_SPECIFIC_PAYLOAD_KEYS) expect(out).not.toHaveProperty(key);
    expect(out).toEqual({
      name: "Ada",
      email: "ada@example.com",
      company: "Analytical",
      linkedinUrl: "https://linkedin.com/in/ada",
      personResearch: { status: "ok", summary: "…" },
      productResearch: { oneLiner: "engines" },
      cohort: "yc-s26",
      postTitle: "Show HN: engines",
      businessAddress: { line1: "1 Main" },
      titleAtFinder: "CTO",
    });
    // A copy, never the caller's object.
    expect(out).not.toBe(payload);
  });

  it("is null for anything that is not a plain object", () => {
    expect(portableQueuePayload(null)).toBeNull();
    expect(portableQueuePayload("{}")).toBeNull();
    expect(portableQueuePayload([1])).toBeNull();
    expect(portableQueuePayload({})).toEqual({});
  });
});
