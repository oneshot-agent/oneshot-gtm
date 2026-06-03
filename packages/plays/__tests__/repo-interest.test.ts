import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies the repo-interest play drafts a complementary intro: the inputBlock
// carries the STARRED REPO + yourEdge, and it's one-touch (no cadence enroll).

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
      findProspectByEmail: () => null,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      // If repo-interest ever tried to enroll, this would fire — it must not.
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

const { runRepoInterest } = await import("../src/repo-interest.ts");

const base = { name: "Ada", email: "ada@acme.dev", company: "Acme" } as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runRepoInterest", () => {
  it("drafts with the starred repo (label) + yourEdge in the input block", async () => {
    await runRepoInterest({
      dryRun: true,
      targets: [
        {
          ...base,
          repo: "modelcontextprotocol/servers",
          repoLabel: "MCP servers",
          yourEdge: "one SDK for the tools they wire up",
        },
      ],
    });
    expect(calls.llmInputBlocks[0]).toContain("STARRED REPO: MCP servers");
    expect(calls.llmInputBlocks[0]).toContain("YOUR EDGE: one SDK for the tools they wire up");
  });

  it("falls back to the raw repo when no label is set", async () => {
    await runRepoInterest({
      dryRun: true,
      targets: [{ ...base, repo: "owner/name", yourEdge: "x" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("STARRED REPO: owner/name");
  });

  it("is one-touch: never enrolls a cadence on send", async () => {
    const out = await runRepoInterest({
      dryRun: false,
      targets: [{ ...base, repo: "owner/name", yourEdge: "x" }],
    });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(0);
  });
});
