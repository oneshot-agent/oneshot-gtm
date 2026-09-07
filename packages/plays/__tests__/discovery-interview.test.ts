import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies discovery-interview drafts a learn-not-sell ask: the inputBlock
// carries BUSINESS TYPE + TOPIC, and it enrolls a 2-touch cadence (ask + one
// soft re-ask, no breakup) on a real send — mirrors repo-interest's shape.

const calls = { llmInputBlocks: [] as string[], enrolled: 0 };
let completeResponse: { subject: string; body: string } = { subject: "s", body: "b" };

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
      getCadence: () => null,
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
      return { content: JSON.stringify(completeResponse), provider: "t", model: "t" };
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
  completeResponse = { subject: "s", body: "b" };
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

  // finding apps/web/src/lib/playSchemas.ts:417: the web form's required-field
  // check is client-side only, so a target that bypasses it (a direct API
  // call, a hand-edited queue row) must still be rejected before any paid
  // call rather than reaching buildInputBlock with an undefined field.
  it("refuses a target missing a required field, before any paid call", async () => {
    const { businessType: _drop, ...withoutBusinessType } = base;
    const out = await runDiscoveryInterview({
      dryRun: true,
      targets: [withoutBusinessType as typeof base],
    });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags.some((f) => f.startsWith("error:"))).toBe(true);
    expect(calls.llmInputBlocks).toHaveLength(0);
  });

  it("refuses a target whose required field is blank/whitespace-only", async () => {
    const out = await runDiscoveryInterview({
      dryRun: true,
      targets: [{ ...base, topic: "   " }],
    });
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags.some((f) => f.startsWith("error:"))).toBe(true);
    expect(calls.llmInputBlocks).toHaveLength(0);
  });

  // finding PR #552: runEmailPlay's dupe-detection pass called
  // `def.toEmail(t).trim()` on every target BEFORE the per-target try/catch,
  // so one target with a missing/non-string email threw a TypeError that
  // rejected the whole batch instead of landing as that one target's
  // errorDraft. A good target queued alongside a bad one must still draft.
  it("doesn't let a target with a missing email crash the rest of the batch", async () => {
    const { email: _drop, ...withoutEmail } = base;
    const out = await runDiscoveryInterview({
      dryRun: true,
      targets: [withoutEmail as unknown as typeof base, base],
    });
    expect(out.drafted).toHaveLength(2);
    const [bad, good] = out.drafted;
    expect(bad?.sent).toBe(false);
    expect(bad?.flags.some((f) => f.startsWith("error:"))).toBe(true);
    expect(good?.flags.some((f) => f.startsWith("error:"))).toBe(false);
  });

  // finding discovery-interview-email.md:9: lintEmail() alone never checked
  // for a product link/price/discount, so a completion violating the
  // prompt's hard bans could reach sendDraftedEmail with an empty flags
  // array. hardBans: true wires hardBanFlags() into the pre-send flag set.
  it("holds a draft whose body violates the hard-ban link/price/discount rules", async () => {
    completeResponse = {
      subject: "s",
      body: "Check out https://example.com - it's $50/mo, free trial available.",
    };
    const out = await runDiscoveryInterview({ dryRun: false, targets: [base] });
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags).toContain("hard-ban:link");
    expect(out.drafted[0]?.flags).toContain("hard-ban:price");
    expect(out.drafted[0]?.flags).toContain("hard-ban:discount-offer");
  });
});
