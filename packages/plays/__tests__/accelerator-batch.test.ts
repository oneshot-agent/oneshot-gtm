import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sender's own accelerator batch is founder truth: it comes from
// `founderCohort` in config and from nowhere else. It used to ride on the
// target row, stamped from a trigger field a readiness gate made mandatory,
// which is how installs ended up claiming a batch the founder was never in —
// so a stale stamp on an old queue row must not be able to bring it back.

const calls = { llmInputBlocks: [] as string[] };
/** Mutable so a test can turn the peer angle on; reset in beforeEach. */
let founderCohort: string | null = null;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      founderCohort,
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
      // sendDraftedEmail reads the stored ICP verdict before a first touch.
      getProspectById: () => null,
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

const base = {
  name: "Merlin",
  email: "m@rex.inc",
  company: "Rex",
  cohort: "yc-s26",
  yourEdge: "the retry boundary is where the audit trail leaves the sandbox",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  founderCohort = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAcceleratorBatch — the sender's cohort comes from config only", () => {
  it("omits the SENDER COHORT line entirely when the founder was in no batch", async () => {
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).not.toContain("SENDER COHORT");
    // No "(unspecified)" placeholder either — a blank to fill is an invitation
    // to improvise a cohort, which is the failure this play is fixing.
    expect(calls.llmInputBlocks[0]).not.toContain("unspecified");
  });

  it("emits the SENDER COHORT line from config when the founder really did a batch", async () => {
    founderCohort = "yc-w23";
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain("SENDER COHORT: yc-w23");
  });

  it("ignores a cohort still stamped on an old queue row", async () => {
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, senderCohort: "yc-w25", freeForCohortOffer: "free through demo day" }],
    });
    expect(calls.llmInputBlocks[0]).not.toContain("yc-w25");
    expect(calls.llmInputBlocks[0]).not.toContain("SENDER COHORT");
    // The cohort discount is gone with it — a cold sweetener is banned by
    // _humanizer.md, so the prompt must never see one to offer.
    expect(calls.llmInputBlocks[0]).not.toContain("demo day");
  });

  it("config wins over a conflicting stamp on the row", async () => {
    founderCohort = "spc-2023-1";
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, senderCohort: "yc-w25" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("SENDER COHORT: spc-2023-1");
    expect(calls.llmInputBlocks[0]).not.toContain("yc-w25");
  });

  it("passes yourEdge through as the Offer beat's only material", async () => {
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain(`YOUR EDGE: ${base.yourEdge}`);
  });
});
