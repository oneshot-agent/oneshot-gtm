import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies new-business drafts the greenfield ask: the inputBlock carries the
// business type + license/authority + how recently it was issued, and it
// enrolls a cadence whose single follow-up doubles as the breakup — same
// one-touch shape as accelerator-batch and free-pilot.

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

const { runNewBusiness } = await import("../src/new-business.ts");
const { getSequence } = await import("../src/_cadence.ts");

const base = {
  name: "Priya",
  email: "priya@freshstart.dev",
  company: "Fresh Start Dental",
  businessType: "two-chair dental practice",
  licenseType: "dental practice licence",
  issuedAgo: "3 weeks ago",
  yourEdge: "gets new patients booked without a receptionist on day one",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runNewBusiness", () => {
  it("drafts with business type + license/authority + issuedAgo in the input block", async () => {
    await runNewBusiness({ dryRun: true, targets: [base] });
    expect(calls.llmInputBlocks[0]).toContain("BUSINESS TYPE: two-chair dental practice");
    expect(calls.llmInputBlocks[0]).toContain(
      "LICENSE/AUTHORITY: dental practice licence, issued 3 weeks ago",
    );
  });

  it("enrolls a cadence on a real send", async () => {
    const out = await runNewBusiness({ dryRun: false, targets: [base] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });

  it("is one-touch + a single follow-up that doubles as the breakup (accelerator-batch shape)", () => {
    const seq = getSequence("new-business");
    expect(seq?.steps).toHaveLength(1);
    expect(seq?.steps[0]?.label).toMatch(/breakup/i);
  });
});
