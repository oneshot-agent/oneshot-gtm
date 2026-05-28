import { afterEach, describe, expect, it, vi } from "vitest";

// effectiveSequence reads loadConfig().cadenceOverrides; control it here.
let mockCadenceOverrides: Record<string, number[]> | null = null;
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: null,
      founderEmail: null,
      productOneLiner: null,
      productDomain: null,
      icpOneLiner: null,
      cadenceOverrides: mockCadenceOverrides,
      clientId: null,
    }),
  };
});

const { registerSequence, effectiveSequence } = await import("../src/_cadence.ts");

const PLAY = "__cadence-override-test";
registerSequence({
  playName: PLAY,
  steps: [
    { dayOffset: 3, channel: "email", breakOnReply: true, label: "a", builder: async () => null },
    { dayOffset: 8, channel: "email", breakOnReply: true, label: "b", builder: async () => null },
  ],
});

afterEach(() => {
  mockCadenceOverrides = null;
});

describe("effectiveSequence — cadence timing overrides", () => {
  it("replaces step dayOffsets when the override length matches", () => {
    mockCadenceOverrides = { [PLAY]: [4, 9] };
    expect(effectiveSequence(PLAY)?.steps.map((s) => s.dayOffset)).toEqual([4, 9]);
  });

  it("ignores an override whose length differs from the step count", () => {
    mockCadenceOverrides = { [PLAY]: [4] };
    expect(effectiveSequence(PLAY)?.steps.map((s) => s.dayOffset)).toEqual([3, 8]);
  });

  it("falls back to code defaults when no override is set", () => {
    mockCadenceOverrides = null;
    expect(effectiveSequence(PLAY)?.steps.map((s) => s.dayOffset)).toEqual([3, 8]);
  });

  it("preserves step structure (labels) under an override", () => {
    mockCadenceOverrides = { [PLAY]: [1, 2] };
    expect(effectiveSequence(PLAY)?.steps.map((s) => s.label)).toEqual(["a", "b"]);
  });
});
