import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies design-partner-loi drafts the first rung of the ask ladder (a
// scoped conversation ask, not a pilot or LOI ask), enrolls the 3-step ladder
// cadence on a real send, and — the acceptance criterion in issue #463 —
// REFUSES to draft for an owner-operator buyer rather than relying on the
// finders routing correctly by convention.

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

const { runDesignPartnerLoi, assertNotOwnerOperatorBuyer } =
  await import("../src/design-partner-loi.ts");

const base = {
  name: "Jamie Buyer",
  email: "jamie@enterprise-corp.com",
  company: "Enterprise Corp",
  buyerType: "enterprise",
  yourEdge: "our evaluation harness matches their exact compliance checklist",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("assertNotOwnerOperatorBuyer — the routing guard", () => {
  it("throws for owner-operator (and case/whitespace variants)", () => {
    expect(() => assertNotOwnerOperatorBuyer("owner-operator")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("Owner-Operator")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("  owner operator  ")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("main-street")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("main street")).toThrow();
  });

  it("does not throw for enterprise / government / hardware", () => {
    expect(() => assertNotOwnerOperatorBuyer("enterprise")).not.toThrow();
    expect(() => assertNotOwnerOperatorBuyer("government")).not.toThrow();
    expect(() => assertNotOwnerOperatorBuyer("hardware")).not.toThrow();
  });
});

describe("runDesignPartnerLoi", () => {
  it("drafts a design-partner conversation ask, naming the buyer type", async () => {
    await runDesignPartnerLoi({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain("BUYER TYPE: enterprise");
    expect(calls.llmInputBlocks[0]).toContain("PROSPECT: Jamie Buyer at Enterprise Corp");
  });

  it("enrolls the ask-ladder cadence on a real send", async () => {
    const out = await runDesignPartnerLoi({ dryRun: false, targets: [{ ...base }] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });

  // The acceptance criterion: design-partner-loi must never be routed at an
  // owner-operator, asserted here rather than trusted to finder config — a
  // future pack could point the wrong lane at it. This is BEFORE any paid
  // call (no LLM draft is produced), and lands as an errorDraft, not a sent
  // email, so the target never reaches a real send.
  it("refuses to draft for an owner-operator buyerType, before any paid call", async () => {
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "owner-operator" }],
    });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags.some((f) => f.startsWith("error:"))).toBe(true);
    // No LLM call was made for this target — the guard fires in `prepare`.
    expect(calls.llmInputBlocks).toHaveLength(0);
  });

  it("refuses a main-street buyerType the same way", async () => {
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "main-street" }],
    });
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags.some((f) => f.startsWith("error:"))).toBe(true);
  });
});
