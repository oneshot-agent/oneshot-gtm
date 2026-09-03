import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies discovery-interview drafts a learn-not-sell ask: the inputBlock
// carries BUSINESS TYPE + TOPIC, and it enrolls a 2-touch cadence (ask + one
// soft re-ask, no breakup) on a real send — mirrors repo-interest's shape.

const calls = { llmInputBlocks: [] as string[], enrolled: 0 };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "thing",
      productDomain: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: {} }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => ({ id: 1 }),
      listSequenceEventsForProspectPlay: () => [],
      prospectHasFirstTouch: () => false,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      enrollCadence: () => {
        calls.enrolled++;
      },
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.llmInputBlocks.push(input.messages.find((m) => m.role === "user")?.content ?? "");
      return { content: JSON.stringify({ subject: "s", body: "b" }), provider: "t", model: "t" };
    },
  };
});

const { runDiscoveryInterview } = await import("../src/discovery-interview.ts");

const base = {
  name: "Maria",
  email: "maria@lacocina.dev",
  company: "La Cocina Taqueria",
  businessType: "family-owned taqueria",
  topic: "how they schedule staff shifts",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runDiscoveryInterview", () => {
  it("drafts with business type + topic in the input block", async () => {
    await runDiscoveryInterview({ dryRun: true, targets: [base] });
    expect(calls.llmInputBlocks[0]).toContain("BUSINESS TYPE: family-owned taqueria");
    expect(calls.llmInputBlocks[0]).toContain("TOPIC: how they schedule staff shifts");
  });

  it("is 2-touch: enrolls a cadence on a real send", async () => {
    const out = await runDiscoveryInterview({ dryRun: false, targets: [base] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });
});
