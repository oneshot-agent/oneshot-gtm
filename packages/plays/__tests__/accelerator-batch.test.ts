import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sender's own accelerator batch is founder truth: it comes from
// `founderCohort` in config and from nowhere else. It used to ride on the
// target row, stamped from a trigger field a readiness gate made mandatory,
// which is how installs ended up claiming a batch the founder was never in —
// so a stale stamp on an old queue row must not be able to bring it back.

const calls = {
  llmInputBlocks: [] as string[],
  /** The last message of each call: the redraft turn, when there is one. */
  lastTurns: [] as string[],
  /** Draft responses served in order; empty → a clean default draft. */
  replies: [] as string[],
};
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
      calls.lastTurns.push(input.messages.at(-1)?.content ?? "");
      return {
        content: calls.replies.shift() ?? JSON.stringify({ subject: "s", body: "b" }),
        provider: "t",
        model: "t",
      };
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
  calls.lastTurns = [];
  calls.replies = [];
  founderCohort = null;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("runAcceleratorBatch — demo day is a fact judged at draft time", () => {
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };

  it("carries a passed demo day for a past cohort", async () => {
    at("2026-09-25T12:00:00Z");
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base, cohort: "yc-w26" }] });
    expect(calls.llmInputBlocks[0]).toContain("DEMO DAY: March 2026 (passed, ~6 months ago)");
  });

  it("carries an upcoming demo day, from the stamped month", async () => {
    at("2026-09-25T12:00:00Z");
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, cohort: "yc-f26", demoDayMonth: "2026-12" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("DEMO DAY: December 2026 (upcoming, in ~3 months)");
  });

  it("carries no line for a cohort with no known schedule", async () => {
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base, cohort: "antler-2026" }] });
    expect(calls.llmInputBlocks[0]).not.toContain("DEMO DAY");
  });

  it("redrafts a first touch that mentions a passed demo day, and flags one that keeps it", async () => {
    at("2026-09-25T12:00:00Z");
    calls.replies.push(
      JSON.stringify({ subject: "s", body: "Numbers ready for demo day?" }),
      JSON.stringify({ subject: "s", body: "Are you logging replies yet?" }),
    );
    const fixed = await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, cohort: "yc-w26" }],
    });
    expect(calls.lastTurns[1]).toContain("Their demo day was March 2026");
    expect(fixed.drafted[0]!.body).toBe("Are you logging replies yet?");
    expect(fixed.drafted[0]!.flags).not.toContain("stale-demo-day");

    calls.replies.push(
      JSON.stringify({ subject: "s", body: "Numbers ready for demo day?" }),
      JSON.stringify({ subject: "s", body: "How did demo day go?" }),
    );
    const held = await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, cohort: "yc-w26" }],
    });
    expect(held.drafted[0]!.body).toBe("Numbers ready for demo day?");
    expect(held.drafted[0]!.flags).toContain("stale-demo-day");
  });
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
