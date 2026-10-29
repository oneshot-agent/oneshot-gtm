import { beforeEach, describe, expect, it, vi } from "vitest";

// A play run writes the prospect offer first, opens the draft's input with
// it, and records it on the send so every later touch carries the same one.

const calls = {
  inputs: [] as string[],
  events: [] as Array<Record<string, unknown>>,
  /** The draft's body; null: a clean one that opens with the offer. */
  body: null as string | null,
};
const OFFER = {
  offer: "get every enterprise corp renewal quote out the same day it is asked for",
  steps: "drafts the quote, checks the price list and sends it for approval",
  evidence: ["renewal quotes"],
  stage: "enterprise",
  level: "researched",
  return: "renewals closed before the customer shops around, counted per renewal",
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "thing",
      productBrief: "Thing drafts quotes, checks price lists and sends them for approval.",
      pilotOffer: "a month on one team",
      productDomain: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: { note: "renewal quotes" } }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getCachedNewsfeed: () => null,
    getLedger: () => ({
      getCadence: () => null,
      upsertProspect: () => 1,
      recordSequenceEvent: (e: Record<string, unknown>) => {
        calls.events.push(e);
        return 1;
      },
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => ({ id: 1 }),
      getProspectById: () => null,
      listSequenceEventsForProspectPlay: () => [],
      prospectHasFirstTouch: () => false,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      enrollCadence: () => {},
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => name,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const system = input.messages[0]?.content ?? "";
      calls.inputs.push(`${system}\n---\n${input.messages.at(-1)?.content ?? ""}`);
      return {
        content: system.startsWith("prospect-offer")
          ? JSON.stringify(OFFER)
          : JSON.stringify({
              subject: "s",
              body: calls.body ?? `I can ${OFFER.offer}. Worth it?`,
            }),
        provider: "t",
        model: "t",
      };
    },
  };
});

const { runDesignPartnerLoi } = await import("../src/design-partner-loi.ts");

const base = {
  name: "Jamie Buyer",
  email: "jamie@enterprise-corp.com",
  company: "Enterprise Corp",
  buyerType: "enterprise",
  yourEdge: "quotes the same day",
};

beforeEach(() => {
  calls.inputs = [];
  calls.events = [];
  calls.body = null;
});

describe("prospect offer in a play run", () => {
  it("writes the offer, then drafts with it", async () => {
    await runDesignPartnerLoi({ dryRun: true, targets: [{ ...base }] });
    expect(calls.inputs[0]).toMatch(/^prospect-offer/);
    const draft = calls.inputs.find((i) => i.startsWith("design-partner-loi-email"))!;
    expect(draft).toContain(
      `OFFER (what you offer to do for them; the message opens with it): ${OFFER.offer}`,
    );
    expect(draft).toContain(
      "OFFER TERMS (the founder's general terms; never a price): a month on one team",
    );
    expect(draft).toContain("PRODUCT BRIEF (the only source of product claims)");
  });

  it("uses a stored offer as it stands", async () => {
    const { offerProductHash, OFFER_PROMPT_VERSION } = await import("../src/_prospect-offer.ts");
    const productHash = offerProductHash({
      productOneLiner: "thing",
      productBrief: "Thing drafts quotes, checks price lists and sends them for approval.",
      pilotOffer: "a month on one team",
    });
    const stored = {
      productHash,
      ...OFFER,
      offer: "the stored one",
      version: OFFER_PROMPT_VERSION,
      inputHash: "h",
      derivedAt: "",
    };
    await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, offer: stored } as typeof base],
    });
    expect(calls.inputs.some((i) => i.startsWith("prospect-offer"))).toBe(false);
    expect(calls.inputs.find((i) => i.startsWith("design-partner-loi-email"))).toContain(
      "the stored one",
    );
  });

  it("records the offer on the first send", async () => {
    await runDesignPartnerLoi({ dryRun: false, targets: [{ ...base }] });
    const step0 =
      calls.events.find((e) => e["stepIndex"] === 0 || e["step_index"] === 0) ?? calls.events[0];
    expect(JSON.stringify(step0)).toContain(OFFER.offer);
  });

  it("writes a stored weak offer again before the draft, and sends one the founder approved", async () => {
    const { offerProductHash, OFFER_PROMPT_VERSION } = await import("../src/_prospect-offer.ts");
    const weak = {
      productHash: offerProductHash({
        productOneLiner: "thing",
        productBrief: "Thing drafts quotes, checks price lists and sends them for approval.",
        pilotOffer: "a month on one team",
      }),
      ...OFFER,
      offer: "the weak one",
      relevance: "weak",
      version: OFFER_PROMPT_VERSION,
      inputHash: "h",
      derivedAt: "",
    };
    const rewritten = await runDesignPartnerLoi({
      dryRun: false,
      targets: [{ ...base, offer: weak } as typeof base],
    });
    // Never drafted from: the writer was asked again and the draft opens on its offer.
    expect(calls.inputs.some((i) => i.startsWith("prospect-offer\n"))).toBe(true);
    const draft = calls.inputs.find((i) => i.startsWith("design-partner-loi-email"))!;
    expect(draft).toContain(`: ${OFFER.offer}`);
    expect(draft).not.toContain("the weak one");
    expect(rewritten.drafted[0]).toMatchObject({ sent: true, offer: { offer: OFFER.offer } });

    calls.inputs = [];
    const approvedOffer = { ...weak, weakApprovedAt: "2026-10-19T00:00:00Z" };
    const approved = await runDesignPartnerLoi({
      dryRun: false,
      targets: [{ ...base, offer: approvedOffer } as typeof base],
    });
    expect(calls.inputs.some((i) => i.startsWith("prospect-offer\n"))).toBe(false);
    expect(approved.drafted[0]).toMatchObject({
      sent: true,
      flags: [],
      offer: { offer: "the weak one" },
    });
  });
});
