import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What draftInboxReply's user block contains, per input — the regression suite
// for "the reply draft has nothing real to draw on". The LLM is mocked; we
// assert on the assembled prompt block.

let cfgOverride: { productBrief: string | null; icpOneLiner: string | null } = {
  productBrief: null,
  icpOneLiner: null,
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: "Mira",
      founderEmail: null,
      productOneLiner: "drop-in tracing",
      productDomain: null,
      sendingDomain: null,
      emailProvider: "oneshot",
      emailIdentities: null,
      icpOneLiner: cfgOverride.icpOneLiner,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      productBrief: cfgOverride.productBrief,
      mobileSignature: false,
      clientId: null,
    }),
  };
});

const completeMock = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, complete: completeMock };
});

const { draftInboxReply } = await import("../src/reply.ts");

function lastUserBlock(): string {
  const call = completeMock.mock.calls.at(-1)?.[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return call.messages.find((m) => m.role === "user")?.content ?? "";
}

beforeEach(() => {
  cfgOverride = { productBrief: null, icpOneLiner: null };
  completeMock.mockResolvedValue({ content: JSON.stringify({ body: "drafted." }) });
});

afterEach(() => {
  vi.clearAllMocks();
});

const BASE = { fromEmail: "a@b.dev", subject: "Re: x", body: "tell me about payments" };

describe("draftInboxReply context assembly", () => {
  it("injects PRODUCT BRIEF and ICP when configured", async () => {
    cfgOverride = {
      productBrief: "Settled per call in USDC on Base.\nhttps://docs.example.com/payments",
      icpOneLiner: "seed-stage agent builders",
    };
    await draftInboxReply(BASE);
    const block = lastUserBlock();
    expect(block).toContain("PRODUCT BRIEF (facts and the ONLY links you may cite):");
    expect(block).toContain("https://docs.example.com/payments");
    expect(block).toContain("ICP: seed-stage agent builders");
  });

  it("omits the brief/ICP blocks cleanly when unset", async () => {
    await draftInboxReply(BASE);
    const block = lastUserBlock();
    expect(block).not.toContain("PRODUCT BRIEF");
    expect(block).not.toContain("ICP:");
  });

  it("injects the sender dossier when research produced one", async () => {
    await draftInboxReply({ ...BASE, dossier: "Runs x402 payments on his own site." });
    expect(lastUserBlock()).toContain(
      "SENDER DOSSIER (research about who wrote this):\nRuns x402 payments on his own site.",
    );
  });

  it("omits the dossier block for blank research", async () => {
    await draftInboxReply({ ...BASE, dossier: "  " });
    expect(lastUserBlock()).not.toContain("SENDER DOSSIER");
  });

  it("injects prior thread replies so round 2 doesn't repeat round 1", async () => {
    await draftInboxReply({
      ...BASE,
      threadSent: [{ body: "Already answered the pricing question.", sentAt: "2026-08-20" }],
    });
    const block = lastUserBlock();
    expect(block).toContain("THREAD — REPLIES YOU ALREADY SENT");
    expect(block).toContain("Already answered the pricing question.");
  });

  it("omits the thread block when there is no history", async () => {
    await draftInboxReply({ ...BASE, threadSent: [] });
    expect(lastUserBlock()).not.toContain("THREAD — REPLIES YOU ALREADY SENT");
  });
});
