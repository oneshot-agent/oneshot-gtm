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

  it("injects the intent directive when intent is classified (issue #480)", async () => {
    await draftInboxReply({ ...BASE, intent: "interested" });
    const block = lastUserBlock();
    expect(block).toContain("INTENT DIRECTIVE");
    expect(block).toContain("interested");
  });

  it("omits the intent directive when intent is null or unhandled", async () => {
    await draftInboxReply({ ...BASE, intent: null });
    expect(lastUserBlock()).not.toContain("INTENT DIRECTIVE");
    await draftInboxReply({ ...BASE, intent: "auto_reply" });
    expect(lastUserBlock()).not.toContain("INTENT DIRECTIVE");
  });

  it("injects the founder steer as a binding block when set (issue #480)", async () => {
    await draftInboxReply({ ...BASE, steer: "docs listing only, no exclusivity" });
    const block = lastUserBlock();
    expect(block).toContain("FOUNDER STEER");
    expect(block).toContain("docs listing only, no exclusivity");
  });

  it("omits the steer block when unset", async () => {
    await draftInboxReply({ ...BASE, steer: null });
    expect(lastUserBlock()).not.toContain("FOUNDER STEER");
  });

  it("derives an ASKS ALREADY MADE block from prior sent replies and excludes it when none", async () => {
    await draftInboxReply({
      ...BASE,
      threadSent: [{ body: "Does later this week work for a quick call?", sentAt: "2026-08-26" }],
    });
    const block = lastUserBlock();
    expect(block).toContain("ASKS ALREADY MADE");
    expect(block).toContain("Does later this week work for a quick call?");

    await draftInboxReply({
      ...BASE,
      threadSent: [{ body: "Sounds good, no rush.", sentAt: "2026-08-26" }],
    });
    expect(lastUserBlock()).not.toContain("ASKS ALREADY MADE");
  });

  // ANGLE injection (issue #356) — the reply-path payoff for #355's synthesis.
  // `doNotSay` matters most here: it's what stops a reply re-asserting a
  // premise the prospect already corrected ("not sure what you mean" /
  // "starred for research").
  it("omits the ANGLE block when angleJson is absent", async () => {
    await draftInboxReply(BASE);
    expect(lastUserBlock()).not.toContain("ANGLE");
  });

  it("omits the ANGLE block for null angle_json — unchanged output (issue #356)", async () => {
    await draftInboxReply({ ...BASE, angleJson: null });
    expect(lastUserBlock()).not.toContain("ANGLE");
  });

  it("omits the ANGLE block for blank/unparsable angle_json — must not throw", async () => {
    await draftInboxReply({ ...BASE, angleJson: "  " });
    expect(lastUserBlock()).not.toContain("ANGLE");
    await draftInboxReply({ ...BASE, angleJson: "not json" });
    expect(lastUserBlock()).not.toContain("ANGLE");
  });

  it("injects hook and doNotSay from angle_json — doNotSay is what stops re-asserting a corrected premise", async () => {
    const angle = JSON.stringify({
      hook: "Just shipped x402 support.",
      doNotSay: ["not sure what you mean by that", "this was starred for research only"],
    });
    await draftInboxReply({ ...BASE, angleJson: angle });
    const block = lastUserBlock();
    expect(block).toContain("ANGLE");
    expect(block).toContain("Hook: Just shipped x402 support.");
    expect(block).toContain("Do NOT say");
    expect(block).toContain("not sure what you mean by that");
    expect(block).toContain("this was starred for research only");
  });

  // MEETING injection (issue #578) — the direct outcome-to-draft path,
  // alongside the indirect tagOutcomeValue -> angle_json path.
  it("omits the MEETING block when there is no meeting", async () => {
    await draftInboxReply(BASE);
    expect(lastUserBlock()).not.toContain("MEETING");
  });

  it("omits the MEETING block for null meeting — byte-identical output with no meeting on the prospect", async () => {
    await draftInboxReply({ ...BASE, meeting: null });
    expect(lastUserBlock()).not.toContain("MEETING");
  });

  it("injects a held meeting as the most specific fact known, outranking the dossier", async () => {
    await draftInboxReply({
      ...BASE,
      meeting: { outcome: "held", note: "They asked about SSO timelines.", summary: "Intro call" },
    });
    const block = lastUserBlock();
    expect(block).toContain("MEETING");
    expect(block).toContain("the call happened");
    expect(block).toContain("outranks the dossier");
    expect(block).toContain("They asked about SSO timelines.");
  });

  it("injects a no-show as non-terminal — re-offer, never acknowledge the miss", async () => {
    await draftInboxReply({ ...BASE, meeting: { outcome: "no_show", note: null, summary: null } });
    const block = lastUserBlock();
    expect(block).toContain("MEETING");
    expect(block).toContain("no-showed");
    expect(block).toContain("Do not acknowledge the no-show");
  });

  it("omits the MEETING block for a cancelled or rescheduled meeting — neither ever happened", async () => {
    await draftInboxReply({
      ...BASE,
      meeting: { outcome: "cancelled", note: null, summary: "Intro call" },
    });
    expect(lastUserBlock()).not.toContain("MEETING");
    await draftInboxReply({
      ...BASE,
      meeting: { outcome: "rescheduled", note: null, summary: "Intro call" },
    });
    expect(lastUserBlock()).not.toContain("MEETING");
  });
});
