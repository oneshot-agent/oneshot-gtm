import { describe, expect, it, vi } from "vitest";

// deepResearch refuses a topic over the platform's limit before any call:
// the platform answers one with a 400 the SDK reports only as "Tool request
// failed", which hid that every company-research call was refused.

const researchMock = vi.hoisted(() => vi.fn());

vi.mock("@oneshot-agent/sdk", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-agent/sdk")>("@oneshot-agent/sdk");
  return {
    ...actual,
    OneShot: class {
      research = researchMock;
    },
  };
});

import { deepResearch, RESEARCH_TOPIC_MAX } from "../src/oneshot.ts";

describe("deepResearch topic limit", () => {
  it("is the platform's 500 characters", () => {
    expect(RESEARCH_TOPIC_MAX).toBe(500);
  });

  it("refuses a longer topic by name, before calling the platform", async () => {
    const topic = "x".repeat(RESEARCH_TOPIC_MAX + 1);
    await expect(deepResearch({ topic }, { playName: "test" })).rejects.toMatchObject({
      name: "ValidationError",
      message: "research topic is 501 characters; the limit is 500",
    });
    expect(researchMock).not.toHaveBeenCalled();
  });
});
