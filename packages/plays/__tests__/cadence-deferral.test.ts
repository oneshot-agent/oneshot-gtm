import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sender-rotation deferral semantics in advanceCadence: when daily caps are
// exhausted, steps must stay due (no advance, no error state, no LLM spend) —
// not fail. Covers both the pre-pass capacity gate and a mid-pass
// SendDeferredError thrown by sendEmail.

const calls = { sendEmail: 0, llm: 0 };
let capacityAvailable = true;
let sendEmailDefers = false;

let cadenceRows: Array<{
  prospect_id: number;
  play_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_due_at: string | null;
  last_polled_at: string | null;
  next_step_draft_json: string | null;
  next_step_drafted_at: string | null;
  prospect_email: string | null;
  prospect_name: string | null;
  prospect_company: string | null;
}> = [];
const advanceCalls: Array<{ prospectId: number; playName: string }> = [];

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
      emailProvider: "oneshot",
      emailIdentities: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: null,
    }),
    hasAnySendCapacity: () => capacityAvailable,
    sendEmail: async () => {
      calls.sendEmail++;
      if (sendEmailDefers) {
        throw new actual.SendDeferredError("all sender identities have reached their daily cap");
      }
      return { receiptId: 7 };
    },
    listInbox: async () => ({ emails: [], has_more: false }),
    getLedger: () => ({
      listAllCadences: () => cadenceRows,
      listActiveCadences: () => cadenceRows.filter((c) => c.status === "active"),
      listCadencesForProspect: (prospectId: number) =>
        cadenceRows.filter((c) => c.prospect_id === prospectId),
      getCadence: (prospectId: number, playName: string) =>
        cadenceRows.find((c) => c.prospect_id === prospectId && c.play_name === playName) ?? null,
      getProspectById: (id: number) => {
        const row = cadenceRows.find((c) => c.prospect_id === id);
        return row
          ? {
              id: row.prospect_id,
              name: row.prospect_name,
              email: row.prospect_email,
              company: row.prospect_company,
              linkedin_url: null,
              dossier_json: null,
              source: "test",
              phone: null,
              created_at: "now",
            }
          : null;
      },
      findProspectByEmail: () => null,
      listSequenceEventsForProspectPlay: () => [],
      recordSequenceEvent: () => 0,
      hasSentSequenceEvent: () => false,
      setCadenceStatus: () => {},
      advanceCadence: (input: { prospectId: number; playName: string }) => {
        advanceCalls.push(input);
      },
      setCadenceDraft: () => {},
      getCadenceDraft: () => null,
      clearCadenceDraft: () => {},
      db: {
        query: (_sql: string) => ({
          get: (id: number) => {
            const row = cadenceRows.find((c) => c.prospect_id === id);
            return row
              ? {
                  id: row.prospect_id,
                  name: row.prospect_name,
                  email: row.prospect_email,
                  company: row.prospect_company,
                  linkedin_url: null,
                  dossier_json: null,
                  source: "test",
                  created_at: new Date().toISOString(),
                }
              : null;
          },
        }),
      },
    }),
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async () => {
      calls.llm++;
      return {
        content: JSON.stringify({ subject: "fresh subject", body: "fresh body" }),
        provider: "test",
        model: "test",
      };
    },
  };
});

const { advanceCadence } = await import("../src/_cadence.ts");
// Register stack-consolidation's sequence so the due step has a real builder.
await import("../src/stack-consolidation.ts");

function seedOverdueCadence(): void {
  cadenceRows = [
    {
      prospect_id: 1,
      play_name: "stack-consolidation",
      current_step: 0,
      status: "active",
      enrolled_at: new Date().toISOString(),
      next_due_at: new Date(Date.now() - 1000).toISOString(),
      last_polled_at: null,
      next_step_draft_json: null,
      next_step_drafted_at: null,
      prospect_email: "p@x.dev",
      prospect_name: "Pat",
      prospect_company: "Acme",
    },
  ];
}

beforeEach(() => {
  calls.sendEmail = 0;
  calls.llm = 0;
  capacityAvailable = true;
  sendEmailDefers = false;
  advanceCalls.length = 0;
  seedOverdueCadence();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("advanceCadence — daily-cap deferral", () => {
  it("capacity gate: skips ALL due steps without LLM drafting or sends; steps stay due", async () => {
    capacityAvailable = false;
    const result = await advanceCadence({ dryRun: false });
    expect(result.stepsExecuted).toBe(0);
    expect(calls.llm).toBe(0);
    expect(calls.sendEmail).toBe(0);
    expect(advanceCalls).toEqual([]);
    const detail = result.details.find((d) => d.playName === "stack-consolidation");
    expect(detail?.action).toBe("skipped");
    expect(detail?.note).toMatch(/deferred: daily send caps reached/);
  });

  it("mid-pass deferral: SendDeferredError from sendEmail marks the step skipped, never advances it", async () => {
    sendEmailDefers = true;
    const result = await advanceCadence({ dryRun: false });
    expect(calls.sendEmail).toBe(1);
    expect(result.stepsExecuted).toBe(0);
    expect(advanceCalls).toEqual([]); // step NOT advanced — stays due for tomorrow
    const detail = result.details.find((d) => d.playName === "stack-consolidation");
    expect(detail?.action).toBe("skipped");
    expect(detail?.note).toMatch(/deferred: daily send caps reached/);
  });

  it("dry-run ignores the capacity gate (no sends happen anyway)", async () => {
    capacityAvailable = false;
    const result = await advanceCadence({ dryRun: true });
    const detail = result.details.find((d) => d.playName === "stack-consolidation");
    expect(detail).toBeDefined();
    expect(detail?.note ?? "").not.toMatch(/deferred/);
    expect(calls.sendEmail).toBe(0);
  });
});
