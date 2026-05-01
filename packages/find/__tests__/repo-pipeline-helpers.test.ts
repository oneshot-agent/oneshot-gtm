import { describe, expect, it } from "vitest";
import { describeForIcp } from "../src/_repo-pipeline.ts";

describe("describeForIcp", () => {
  it("uses vendors when present (combo-driven candidates)", () => {
    const out = describeForIcp({
      url: "https://github.com/x/y",
      title: "y",
      description: "An agent.",
      vendors: ["langchain", "twilio"],
    });
    expect(out).toBe("An agent.  vendors: langchain, twilio");
  });

  it("falls back to topics when vendors is empty (topic-driven candidates)", () => {
    const out = describeForIcp({
      url: "https://github.com/x/y",
      title: "y",
      description: "An agent.",
      vendors: [],
      topics: ["llm-agents", "rag"],
    });
    expect(out).toBe("An agent.  topics: llm-agents, rag");
  });

  it("vendors win over topics when both present (defensive — combos should set vendors)", () => {
    const out = describeForIcp({
      url: "https://github.com/x/y",
      title: "y",
      description: "An agent.",
      vendors: ["stripe"],
      topics: ["llm-agents"],
    });
    expect(out).toContain("vendors: stripe");
    expect(out).not.toContain("topics:");
  });

  it("returns the bare description when neither signal is present (no trailing tag)", () => {
    expect(
      describeForIcp({
        url: "https://github.com/x/y",
        title: "y",
        description: "An agent.",
        vendors: [],
      }),
    ).toBe("An agent.");
    expect(
      describeForIcp({
        url: "https://github.com/x/y",
        title: "y",
        description: "An agent.",
        vendors: [],
        topics: [],
      }),
    ).toBe("An agent.");
  });
});
