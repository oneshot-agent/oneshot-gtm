// The pilot + close final rung: with a pilot offer configured, the builder
// plays' last follow-up offers it (company facts, the offer, a price/link
// hold); without one, the breakup they always had, and repo-interest keeps
// its single ping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectRecord } from "@oneshot-gtm/core";

const llmCalls: Array<{ user: string; system: string }> = [];
let pilotOffer: string | null = null;

function baseCfg() {
  return {
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
    pilotOffer,
  };
}

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => baseCfg(),
    getLedger: () => ({
      findDirectMail: () => null,
      recentSentEmailBodies: () => [],
      getCadence: (pid: number) => ({
        current_step: 1,
        status: "active",
        enrolled_at: pid === 99 ? "2026-10-01T00:00:00Z" : "x",
      }),
      // Prospect 99 enrolled while an offer was set: its saved plan has the pilot step.
      getCadencePlan: (pid: number) =>
        pid === 99
          ? [
              { id: "base:1", channel: "email", dayOffset: 3, label: "value follow-up" },
              { id: "base:2", channel: "email", dayOffset: 7, label: "pilot + close (breakup)" },
            ]
          : null,
      listSequenceEventsForProspectPlay: () => [],
      latestSentQueuePayload: () => null,
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
    loadPrompt: (name: string) => `system:${name}`,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      llmCalls.push({
        system: input.messages.find((m) => m.role === "system")?.content ?? "",
        user: input.messages.findLast((m) => m.role === "user")?.content ?? "",
      });
      return {
        content: JSON.stringify({
          subject: "one workflow at acme",
          body: "Want to build it with us?",
        }),
        provider: "test",
        model: "test",
      };
    },
  };
});

const { getSequence, hardBanHold, pilotOrBreakup } = await import("../src/_cadence.ts");
await import("../src/repo-interest.ts");
await import("../src/stack-consolidation.ts");

function ctx() {
  const prospect = {
    id: 7,
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    linkedin_url: null,
    dossier_json: null,
    angle_json: null,
    source: "test",
    created_at: new Date().toISOString(),
  } as ProspectRecord;
  return { prospect, cfg: baseCfg(), metadata: {} };
}

const OFFER = "Four weeks building one workflow they pick, together.";

beforeEach(() => {
  pilotOffer = null;
  llmCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("pilotOrBreakup", () => {
  const step = (fallback: "breakup" | "none") =>
    pilotOrBreakup({ playName: "stack-consolidation", contextLines: ["PLAY: test."], fallback });

  it("offers the pilot when one is configured, with the offer and a price/link hold", async () => {
    pilotOffer = OFFER;
    const out = await step("breakup")(ctx());
    expect(llmCalls[0]!.system).toContain("system:pilot-close-followup");
    expect(llmCalls[0]!.user).toContain(`PILOT OFFER: ${OFFER}`);
    expect(out).toMatchObject({ kind: "email", hardBans: true });
  });

  it("keeps the plain breakup when no offer is set", async () => {
    const out = await step("breakup")(ctx());
    expect(llmCalls[0]!.system).toContain("system:breakup-email");
    expect(llmCalls[0]!.user).not.toContain("PILOT OFFER");
    expect(out).not.toHaveProperty("hardBans");
  });

  it("sends nothing for an offer-only step when no offer is set", async () => {
    expect(await step("none")(ctx())).toBeNull();
    expect(llmCalls).toHaveLength(0);
  });
});

const email = (body: string, hardBans?: boolean) =>
  ({ kind: "email", subject: "s", body, ...(hardBans ? { hardBans } : {}) }) as const;

describe("hardBanHold", () => {
  it("holds a price or a link only on drafts that must carry neither", () => {
    expect(hardBanHold(email("Four weeks for $500.", true))).toContain("hard-ban:price");
    expect(hardBanHold(email("See https://acme.dev", true))).toContain("hard-ban:link");
    expect(hardBanHold(email("Want to build it together?", true))).toEqual([]);
    expect(hardBanHold(email("See https://acme.dev"))).toEqual([]);
  });
});

describe("sequences", () => {
  it("repo-interest gains the pilot step only while an offer is set", () => {
    expect(getSequence("repo-interest")!.steps.map((s) => s.label)).toEqual(["value follow-up"]);
    pilotOffer = OFFER;
    expect(getSequence("repo-interest")!.steps.map((s) => s.label)).toEqual([
      "value follow-up",
      "pilot + close (breakup)",
    ]);
  });

  it("a cadence planned with the offer still resolves the step after it is turned off", async () => {
    const seq = getSequence("repo-interest", 99)!;
    expect(seq.steps.map((s) => s.label)).toEqual(["value follow-up", "pilot + close (breakup)"]);
    // With no offer its builder sends nothing, so the cadence completes.
    expect(await seq.steps[1]!.builder(ctx())).toBeNull();
  });

  it("stack-consolidation keeps two steps, the last still a breakup", () => {
    pilotOffer = OFFER;
    expect(getSequence("stack-consolidation")!.steps.map((s) => s.label)).toEqual([
      "value follow-up",
      "breakup",
    ]);
  });
});
