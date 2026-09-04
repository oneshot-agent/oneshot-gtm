import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies free-pilot drafts the main-street close: the inputBlock carries
// BUSINESS TYPE + YOUR EDGE, and it enrolls a cadence whose single follow-up
// doubles as the breakup — mirrors accelerator-batch's one-touch shape.

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
      // sendDraftedEmail reads the stored ICP verdict before a first touch.
      getProspectById: () => null,
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

const { runFreePilot } = await import("../src/free-pilot.ts");
const { getSequence } = await import("../src/_cadence.ts");

const base = {
  name: "Dave",
  email: "dave@kowalski.dev",
  company: "Kowalski Plumbing",
  businessType: "two-truck plumbing company",
  yourEdge: "cuts no-show appointments with text reminders",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runFreePilot", () => {
  it("drafts with business type + yourEdge in the input block", async () => {
    await runFreePilot({ dryRun: true, targets: [base] });
    expect(calls.llmInputBlocks[0]).toContain("BUSINESS TYPE: two-truck plumbing company");
    expect(calls.llmInputBlocks[0]).toContain(
      "YOUR EDGE: cuts no-show appointments with text reminders",
    );
  });

  it("enrolls a cadence on a real send", async () => {
    const out = await runFreePilot({ dryRun: false, targets: [base] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });

  it("is one-touch + a single follow-up that doubles as the breakup (accelerator-batch shape)", () => {
    const seq = getSequence("free-pilot");
    expect(seq?.steps).toHaveLength(1);
    expect(seq?.steps[0]?.label).toMatch(/breakup/i);
  });
});
