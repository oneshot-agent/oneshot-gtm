import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies senderCohort is read TARGET-FIRST (finder rows carry their own,
// stamped from trigger config) with the run-level option as a fallback (manual
// /run targets). This is what makes accelerator-batch rows self-contained and
// inline-generatable, like stack-consolidation.

const calls = { llmInputBlocks: [] as string[] };

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
      findProspectByEmail: () => null,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
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

const { runAcceleratorBatch } = await import("../src/accelerator-batch.ts");

const base = { name: "Merlin", email: "m@rex.inc", company: "Rex", cohort: "yc-s26" } as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAcceleratorBatch — senderCohort is target-first", () => {
  it("uses the target's own senderCohort (a finder row), ignoring the run-level option", async () => {
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, senderCohort: "yc-w23", freeForCohortOffer: "free for w23" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("SENDER COHORT: yc-w23");
    expect(calls.llmInputBlocks[0]).toContain("FREE-FOR-COHORT OFFER: free for w23");
  });

  it("falls back to the run-level senderCohort for a manual target with none of its own", async () => {
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base }],
      senderCohort: "od-2",
      freeForCohortOffer: "free for od",
    });
    expect(calls.llmInputBlocks[0]).toContain("SENDER COHORT: od-2");
    expect(calls.llmInputBlocks[0]).toContain("FREE-FOR-COHORT OFFER: free for od");
  });

  it("target senderCohort overrides the run-level fallback when both are present", async () => {
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, senderCohort: "yc-w23" }],
      senderCohort: "od-2",
    });
    expect(calls.llmInputBlocks[0]).toContain("SENDER COHORT: yc-w23");
  });

  it("renders (unspecified) when neither target nor run-level supplies a cohort", async () => {
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain("SENDER COHORT: (unspecified)");
  });
});
