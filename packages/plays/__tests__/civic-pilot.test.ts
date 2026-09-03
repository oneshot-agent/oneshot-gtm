import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies the civic-pilot play drafts a procedural pilot pitch: the
// inputBlock carries the AGENDA ITEM, MEETING DATE and PURCHASING VEHICLE,
// and it enrolls a 2-touch cadence (initial + one day-5 follow-up).

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

const { runCivicPilot } = await import("../src/civic-pilot.ts");

const base = {
  name: "Jordan Manager",
  email: "jordan.manager@austintexas.gov",
  city: "Austin",
  agendaItemTitle: "AI vendor evaluation for permitting workflow",
  meetingDate: "2026-06-10",
  purchasingVehicle: "Sourcewell",
  yourEdge: "our permit-review model already handles the exact document types on the item",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runCivicPilot", () => {
  it("names the agenda item, meeting date, and purchasing route in the input block", async () => {
    await runCivicPilot({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain(
      "AGENDA ITEM: AI vendor evaluation for permitting workflow",
    );
    expect(calls.llmInputBlocks[0]).toContain("MEETING DATE: 2026-06-10");
    expect(calls.llmInputBlocks[0]).toContain(
      "PURCHASING ROUTE: cooperative purchasing vehicle: Sourcewell",
    );
    expect(calls.llmInputBlocks[0]).toContain("PROSPECT: Jordan Manager at Austin");
  });

  // finding PRRT_kwDOSKzrBs6fD-hc / issue #463: the pilot must be sized under
  // the micro-purchase threshold OR bought off a cooperative vehicle — a
  // target that only gave the threshold route must not be forced to name a
  // vehicle, and the threshold must appear in the drafting input.
  it("supports the micro-purchase-threshold-only route (no purchasing vehicle)", async () => {
    const { purchasingVehicle: _drop, ...withoutVehicle } = base;
    await runCivicPilot({
      dryRun: true,
      targets: [{ ...withoutVehicle, microPurchaseThreshold: "$10,000" }],
    });
    expect(calls.llmInputBlocks[0]).toContain(
      "PURCHASING ROUTE: micro-purchase threshold: $10,000",
    );
  });

  it("refuses to draft when neither purchasing vehicle nor threshold is set", async () => {
    const { purchasingVehicle: _drop, ...withoutVehicle } = base;
    const out = await runCivicPilot({ dryRun: true, targets: [{ ...withoutVehicle }] });
    // The per-target error is caught by the shared runner and lands as an
    // errorDraft (flags: ["error: ..."]) rather than throwing out of
    // runCivicPilot — assert the flag names the refusal reason.
    expect(out.drafted[0]?.flags[0]).toContain("refusing to draft");
  });

  it("enrolls a cadence on a real send (day-5 follow-up)", async () => {
    const out = await runCivicPilot({ dryRun: false, targets: [{ ...base }] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });
});
