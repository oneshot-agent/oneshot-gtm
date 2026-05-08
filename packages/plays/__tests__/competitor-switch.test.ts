import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = {
  enrichProfile: 0,
  browserTask: 0,
  sendEmail: 0,
  llm: 0,
  llmInputBlocks: [] as string[],
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      telemetryEnabled: false,
      founderName: "Founder",
      founderEmail: "f@x.dev",
      productOneLiner: "OneShot SDK",
      icpOneLiner: "Engineers",
      clientId: "test",
    }),
    enrichProfile: async () => {
      calls.enrichProfile++;
      return { result: { profile: {} }, receiptId: 1 };
    },
    browserTask: async () => {
      calls.browserTask++;
      return {
        result: {
          output: { pain_points: ["scraped"], wished_features: [], use_case_context: "" },
        },
        receiptId: 2,
      };
    },
    sendEmail: async () => {
      calls.sendEmail++;
      return { receiptId: 3 };
    },
    getLedger: () => ({
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      findProspectByEmail: () => null,
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
      calls.llm++;
      const userMsg = input.messages.find((m) => m.role === "user")?.content ?? "";
      calls.llmInputBlocks.push(userMsg);
      return {
        content: JSON.stringify({ subject: "subj", body: "body" }),
        provider: "test",
        model: "test",
      };
    },
  };
});

const { runCompetitorSwitch } = await import("../src/competitor-switch.ts");

beforeEach(() => {
  calls.enrichProfile = 0;
  calls.browserTask = 0;
  calls.sendEmail = 0;
  calls.llm = 0;
  calls.llmInputBlocks = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runCompetitorSwitch — browserTask gating", () => {
  it("SKIPS browserTask when evidenceText is supplied (even if evidenceUrl is set too)", async () => {
    // This is exactly what github-topics enqueues: BOTH fields populated.
    // Pre-fix the play would scrape — wasting 30s-3min on a code page that
    // doesn't contain "pain points" or user complaints. Post-fix: trust the
    // text we already built from the manifest scan.
    await runCompetitorSwitch({
      dryRun: false,
      targets: [
        {
          name: "Danny",
          email: "danny@librechat.ai",
          company: "danny-avila",
          competitor: "playwright",
          evidenceUrl: "https://github.com/danny-avila/LibreChat",
          evidenceText: "Their repo stitches together playwright, sse, tavily — 3 vendors.",
          yourEdge: "x402 native",
        },
      ],
    });
    expect(calls.browserTask).toBe(0);
    // The play still ran enrichProfile + LLM draft.
    expect(calls.enrichProfile).toBe(1);
    expect(calls.llm).toBe(1);
    // The supplied text reached the LLM as the EVIDENCE block.
    expect(calls.llmInputBlocks[0]).toContain(
      "EVIDENCE: Their repo stitches together playwright, sse, tavily",
    );
  });

  it("RUNS browserTask when only evidenceUrl is supplied (G2-style review page)", async () => {
    // Original use case: founder pastes a G2 review URL. No text. Scrape
    // extracts pain points the play can use in the email.
    await runCompetitorSwitch({
      dryRun: false,
      targets: [
        {
          name: "Pat",
          email: "pat@acme.com",
          company: "Acme",
          competitor: "Apollo",
          evidenceUrl: "https://www.g2.com/products/apollo-io/reviews/123",
          // No evidenceText.
          yourEdge: "no scraped emails",
        },
      ],
    });
    expect(calls.browserTask).toBe(1);
    // Scraped output reaches the LLM (not "(no evidence supplied)").
    expect(calls.llmInputBlocks[0]).toContain('"pain_points":["scraped"]');
  });

  it("SKIPS browserTask when evidenceText is whitespace-only (treated as missing)", async () => {
    await runCompetitorSwitch({
      dryRun: false,
      targets: [
        {
          name: "Pat",
          email: "pat@acme.com",
          company: "Acme",
          competitor: "Apollo",
          evidenceUrl: "https://www.g2.com/products/apollo-io/reviews/123",
          evidenceText: "   ",
          yourEdge: "x",
        },
      ],
    });
    // Whitespace-only text should NOT block the scrape.
    expect(calls.browserTask).toBe(1);
  });

  it("respects skipBrowserScrape opt-out even with no evidenceText", async () => {
    await runCompetitorSwitch({
      dryRun: false,
      targets: [
        {
          name: "Pat",
          email: "pat@acme.com",
          company: "Acme",
          competitor: "Apollo",
          evidenceUrl: "https://www.g2.com/products/apollo-io/reviews/123",
          yourEdge: "x",
        },
      ],
      skipBrowserScrape: true,
    });
    expect(calls.browserTask).toBe(0);
    expect(calls.llmInputBlocks[0]).toContain("EVIDENCE: (no evidence supplied)");
  });

  it("dryRun skips ALL paid steps regardless of evidence shape", async () => {
    await runCompetitorSwitch({
      dryRun: true,
      targets: [
        {
          name: "Pat",
          email: "pat@acme.com",
          company: "Acme",
          competitor: "Apollo",
          evidenceUrl: "https://www.g2.com/products/apollo-io/reviews/123",
          yourEdge: "x",
        },
      ],
    });
    expect(calls.enrichProfile).toBe(0);
    expect(calls.browserTask).toBe(0);
    expect(calls.sendEmail).toBe(0);
    // LLM draft still runs in dryRun (so the founder sees what would be sent).
    expect(calls.llm).toBe(1);
  });
});
