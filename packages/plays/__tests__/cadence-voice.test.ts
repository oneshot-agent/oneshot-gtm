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
        content:
          llmQueue.shift() ?? nextLlmContent ?? JSON.stringify({ subject: "ok", body: "ok body" }),
        provider: "test",
        model: "test",
      };
    },
  };
});

/** Per-test override of the LLM response. null = default clean JSON. */
let nextLlmContent: string | null = null;
/** Responses served in order before falling back to `nextLlmContent`. */
const llmQueue: string[] = [];
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
  llmQueue.length = 0;
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

describe("buildFollowUpEmail — either/or closing question", () => {
  const builder = () =>
    buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "breakup-email",
      contextLines: ["PLAY: stack-consolidation. Breakup."],
    });
  const eitherOr = JSON.stringify({
    subject: "s",
    body: "Is it sorted already, or still on the back burner?",
  });

  it("redrafts once and keeps a redraft that fixes the ending", async () => {
    llmQueue.push(
      eitherOr,
      JSON.stringify({ subject: "s", body: "Is it still on the list this quarter?" }),
    );
    const out = await builder()(ctx());
    expect(llmCalls).toHaveLength(2);
    expect(out).toMatchObject({ body: "Is it still on the list this quarter?" });
  });

  it("keeps the original when the redraft still offers two options", async () => {
    llmQueue.push(eitherOr, eitherOr);
    const out = await builder()(ctx());
    expect(llmCalls).toHaveLength(2);
    expect(out).toMatchObject({ body: "Is it sorted already, or still on the back burner?" });
  });

  it("makes no second call for a clean ending", async () => {
    await builder()(ctx());
    expect(llmCalls).toHaveLength(1);
  });
});

/** The intro's step-0 sequence row, with extra metadata. */
function intro(meta: Record<string, unknown>) {
  return [{ step_index: 0, metadata_json: JSON.stringify({ subject: "s", body: "b", ...meta }) }];
}

describe("buildFollowUpEmail — demo day judged at draft time", () => {
  const builder = () =>
    buildFollowUpEmail({
      playName: "accelerator-batch",
      promptName: "breakup-email",
      contextLines: ["PLAY: accelerator-batch. Breakup."],
    });
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recomputes from the intro's cohort: upcoming before, passed after", async () => {
    storedRows = intro({ prospectCohort: "yc-w26" });
    at("2026-02-10T12:00:00Z");
    await builder()(ctx());
    expect(llmCalls[0]!.user).toContain("DEMO DAY: March 2026 (upcoming, in ~1 month)");
    llmCalls.length = 0;
    at("2026-09-25T12:00:00Z");
    await builder()(ctx());
    expect(llmCalls[0]!.user).toContain("DEMO DAY: March 2026 (passed, ~6 months ago)");
  });

  it("prefers the stamped demo-day month over the cohort id", async () => {
    storedRows = intro({ prospectCohort: "yc-w26", demoDayMonth: "2026-04" });
    at("2026-09-25T12:00:00Z");
    await builder()(ctx());
    expect(llmCalls[0]!.user).toContain("DEMO DAY: April 2026 (passed, ~5 months ago)");
  });

  it("carries no line when the cohort has no known schedule", async () => {
    storedRows = intro({ prospectCohort: "antler-2026" });
    await builder()(ctx());
    expect(llmCalls[0]!.user).not.toContain("DEMO DAY");
  });

  it("redrafts a passed demo-day mention once, keeping the fix", async () => {
    storedRows = intro({ prospectCohort: "yc-w26" });
    at("2026-09-25T12:00:00Z");
    llmQueue.push(
      JSON.stringify({ subject: "s", body: "Are the numbers ready for demo day?" }),
      JSON.stringify({ subject: "s", body: "Are you logging customer replies anywhere yet?" }),
    );
    const out = await builder()(ctx());
    expect(llmCalls).toHaveLength(2);
    expect(out).toMatchObject({ body: "Are you logging customer replies anywhere yet?" });
  });

  it("keeps the original when the redraft still mentions it", async () => {
    storedRows = intro({ prospectCohort: "yc-w26" });
    at("2026-09-25T12:00:00Z");
    llmQueue.push(
      JSON.stringify({ subject: "s", body: "Are the numbers ready for demo day?" }),
      JSON.stringify({ subject: "s", body: "Did demo day go well?" }),
    );
    const out = await builder()(ctx());
    expect(out).toMatchObject({ body: "Are the numbers ready for demo day?" });
  });

  it("leaves an upcoming demo day alone", async () => {
    storedRows = intro({ prospectCohort: "yc-f26" });
    at("2026-09-25T12:00:00Z");
    llmQueue.push(JSON.stringify({ subject: "s", body: "Is the count ready for demo day?" }));
    await builder()(ctx());
    expect(llmCalls).toHaveLength(1);
  });
});
