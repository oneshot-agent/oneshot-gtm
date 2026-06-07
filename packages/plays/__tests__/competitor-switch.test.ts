import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = {
  enrichProfile: 0,
  browserTask: 0,
  sendEmail: 0,
  llm: 0,
  llmInputBlocks: [] as string[],
};

/** Set to a 1-based call index to make the Nth LLM call throw. */
let throwOnLlmCallNumber: number | null = null;
/** Set to a 1-based call index to make the Nth sendEmail call throw. */
let throwOnSendEmailCallNumber: number | null = null;

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
      productOneLiner: "TestProduct SDK",
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
      if (throwOnSendEmailCallNumber === calls.sendEmail) {
        throw new Error("Job timed out");
      }
      return { receiptId: 3 };
    },
    getLedger: () => ({
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      findProspectByEmail: () => null,
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
      calls.llm++;
      if (throwOnLlmCallNumber === calls.llm) {
        throw new Error("LLM API down");
      }
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
  throwOnLlmCallNumber = null;
  throwOnSendEmailCallNumber = null;
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

  it("per-target try/catch: LLM throws on target 2 → targets 1 and 3 still complete", async () => {
    throwOnLlmCallNumber = 2;
    const out = await runCompetitorSwitch({
      dryRun: false,
      targets: [
        {
          name: "A",
          email: "a@x.com",
          company: "AC",
          competitor: "Apollo",
          evidenceText: "rivals share their stack",
          yourEdge: "x",
        },
        {
          name: "B",
          email: "b@x.com",
          company: "BC",
          competitor: "Apollo",
          evidenceText: "another fact",
          yourEdge: "x",
        },
        {
          name: "C",
          email: "c@x.com",
          company: "CC",
          competitor: "Apollo",
          evidenceText: "third fact",
          yourEdge: "x",
        },
      ],
    });
    expect(out.drafted).toHaveLength(3);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(out.drafted[1]?.sent).toBe(false);
    expect(out.drafted[1]?.flags).toEqual(["error: LLM API down"]);
    expect(out.drafted[2]?.sent).toBe(true);
    // Targets 1 + 3 each fired sendEmail; target 2 didn't.
    expect(calls.sendEmail).toBe(2);
  });

  it("per-target try/catch: sendEmail throws on target 2 → targets 1 and 3 still complete", async () => {
    throwOnSendEmailCallNumber = 2;
    const out = await runCompetitorSwitch({
      dryRun: false,
      targets: [
        {
          name: "A",
          email: "a@x.com",
          company: "AC",
          competitor: "Apollo",
          evidenceText: "fact",
          yourEdge: "x",
        },
        {
          name: "B",
          email: "b@x.com",
          company: "BC",
          competitor: "Apollo",
          evidenceText: "fact",
          yourEdge: "x",
        },
        {
          name: "C",
          email: "c@x.com",
          company: "CC",
          competitor: "Apollo",
          evidenceText: "fact",
          yourEdge: "x",
        },
      ],
    });
    expect(out.drafted).toHaveLength(3);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(out.drafted[1]?.sent).toBe(false);
    expect(out.drafted[1]?.flags).toEqual(["error: Job timed out"]);
    expect(out.drafted[2]?.sent).toBe(true);
  });

  it("dryRun enriches for the dossier but skips the browser scrape + send", async () => {
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
    // Enrich now runs on previews too (cached by email) so the reviewed draft
    // is personalized — but the heavy browser scrape and the send stay gated.
    expect(calls.enrichProfile).toBe(1);
    expect(calls.browserTask).toBe(0);
    expect(calls.sendEmail).toBe(0);
    expect(calls.llm).toBe(1);
  });
});
