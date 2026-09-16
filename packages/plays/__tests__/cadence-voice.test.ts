// The VOICE block on follow-ups and breakups: present only when a card is
// set, after the edge and before the first name, with the breakup budget on
// the breakup prompt; the card's key rides on the payload for the version.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectRecord } from "@oneshot-gtm/core";

const llmCalls: Array<{ user: string; system: string }> = [];
let voiceCard: string | null = null;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "test",
      telemetryEnabled: false,
      founderName: "J",
      founderEmail: "j@x.dev",
      productOneLiner: "TestProduct",
      productDomain: null,
      sendingDomain: null,
      emailProvider: "oneshot" as const,
      emailIdentities: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: "Previously built a million-user app",
      productPortfolio: null,
      partners: null,
      founderAdmission: null,
      productBrief: null,
      founderVoice: voiceCard,
      mobileSignature: false,
      slackWebhookUrl: null,
      timezone: null,
      clientId: null,
      dailySpendCeilingUsd: null,
      calendarIdentityId: null,
      calendarId: "primary",
    }),
    getLedger: () => ({
      findDirectMail: () => null,
      // Opener-frequency cap: no send history in these fakes, so nothing is worn out.
      recentSentEmailBodies: () => [],
      getCadence: () => ({ current_step: 0, status: "active" }),
      listSequenceEventsForProspectPlay: (_pid: number, _play: string) => storedRows,
      // The intro's sent queue row, which the follow-up edge angle is chosen from.
      latestSentQueuePayload: () => sentPayload,
      getProductResearchCache: () => null,
      setProductResearchCache: () => {},
    }),
    receiptUrlForId: (id: number) => `local://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system-prompt",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      llmCalls.push({
        system: input.messages.find((m) => m.role === "system")?.content ?? "",
        user: input.messages.find((m) => m.role === "user")?.content ?? "",
      });
      const user = input.messages.find((m) => m.role === "user")?.content ?? "";
      // The angle classifier (packages/plays/src/_angles.ts): pick the second angle.
      if (user.startsWith("ANGLES:")) {
        return { content: JSON.stringify({ index: 2 }), provider: "test", model: "test" };
      }
      return {
        content: nextLlmContent ?? JSON.stringify({ subject: "ok", body: "ok body" }),
        provider: "test",
        model: "test",
      };
    },
  };
});

/** Per-test override of the LLM response. null = default clean JSON. */
let nextLlmContent: string | null = null;
/** The intro's sent queue payload (issue #584); null = no multi-angle edge to draw on. */
let sentPayload: Record<string, unknown> | null = null;

let storedRows: Array<{
  step_index: number;
  metadata_json: string | null;
  status?: string;
  created_at?: string;
}> = [];

const { buildFollowUpEmail } = await import("../src/_cadence.ts");

function ctx(prospectId = 42, angleJson: string | null = null) {
  const prospect: ProspectRecord = {
    id: prospectId,
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    linkedin_url: null,
    dossier_json: null,
    angle_json: angleJson,
    source: "test",
    created_at: new Date().toISOString(),
  } as ProspectRecord;
  return {
    prospect,
    cfg: {
      walletMode: "cdp" as const,
      llmProvider: "anthropic" as const,
      llmModel: "test",
      telemetryEnabled: false,
      founderName: "J",
      founderEmail: "j@x.dev",
      productOneLiner: "TestProduct",
      productDomain: null,
      sendingDomain: null,
      emailProvider: "oneshot" as const,
      emailIdentities: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      founderAdmission: null,
      productBrief: null,
      mobileSignature: false,
      slackWebhookUrl: null,
      timezone: null,
      clientId: null,
      dailySpendCeilingUsd: null,
      calendarIdentityId: null,
      calendarId: "primary",
    },
    metadata: {},
  };
}

beforeEach(() => {
  voiceCard = null;
  llmCalls.length = 0;
  nextLlmContent = null;
  storedRows = [];
  sentPayload = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildFollowUpEmail — VOICE block", () => {
  const CARD =
    "MOVES\n- a fact, the mechanism under it, one flat line\nEXEMPLARS\n- cost is information.";

  it("carries the card with the follow-up budget and stamps the payload with its key", async () => {
    voiceCard = CARD;
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "stack-consolidation-followup",
      contextLines: ["PLAY: stack-consolidation. Day-3 value follow-up."],
    });
    const out = await builder(ctx());
    const userMsg = llmCalls[0]!.user;
    expect(userMsg).toContain("VOICE (the founder's own register");
    expect(userMsg).toContain("cost is information.");
    expect(userMsg).toContain("VOICE BUDGET: at most ONE aphoristic");
    expect(userMsg.indexOf("VOICE (")).toBeGreaterThan(
      userMsg.indexOf("PLAY: stack-consolidation"),
    );
    expect(out).toMatchObject({ kind: "email", voiceKey: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it("gives the breakup prompt the no-aphorism budget", async () => {
    voiceCard = CARD;
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "breakup-email",
      contextLines: ["PLAY: stack-consolidation. Breakup."],
    });
    await builder(ctx());
    expect(llmCalls[0]!.user).toContain("no aphorism in a breakup");
    expect(llmCalls[0]!.user).not.toContain("at most ONE aphoristic");
  });

  it("is absent, with no key on the payload, when no card is set", async () => {
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "stack-consolidation-followup",
      contextLines: ["PLAY: stack-consolidation."],
    });
    const out = await builder(ctx());
    expect(llmCalls[0]!.user).not.toContain("VOICE");
    expect(out).toEqual({ kind: "email", subject: "ok", body: "ok body" });
  });
});
