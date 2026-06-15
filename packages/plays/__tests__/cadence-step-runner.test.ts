import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = {
  sendEmail: 0,
  llm: 0,
  lastSendEmailArgs: null as { to: string; subject: string; body: string } | null,
  lastSendEmailCtx: null as {
    playName: string;
    memo?: string;
    decisionContext?: Record<string, unknown>;
  } | null,
};

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
let persistedDraft: {
  subject: string;
  body: string;
  flags: string[];
  payload: unknown;
  draftedAt: string;
} | null = null;
const advanceCalls: Array<{
  prospectId: number;
  playName: string;
  newStep: number;
  nextDueAt: string | null;
}> = [];
const sendErrorCalls: Array<{ prospectId: number; playName: string; error: string }> = [];
let throwOnSend = false;
let deferOnSend = false;

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
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: null,
    }),
    sendEmail: async (
      input: { to: string; subject: string; body: string },
      ctx: {
        playName: string;
        memo?: string;
        decisionContext?: Record<string, unknown>;
      },
    ) => {
      if (deferOnSend) {
        const e = new Error("deferred: daily send caps reached");
        e.name = "SendDeferredError";
        throw e;
      }
      if (throwOnSend) throw new Error("Job failed: Tool execution failed. (ref: test123)");
      calls.sendEmail++;
      calls.lastSendEmailArgs = input;
      calls.lastSendEmailCtx = ctx;
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
      setCadenceStatus: () => {},
      recordCadenceSendError: (input: { prospectId: number; playName: string; error: string }) => {
        sendErrorCalls.push(input);
      },
      advanceCadence: (input: {
        prospectId: number;
        playName: string;
        newStep: number;
        nextDueAt: string | null;
      }) => {
        advanceCalls.push(input);
        const row = cadenceRows.find(
          (c) => c.prospect_id === input.prospectId && c.play_name === input.playName,
        );
        if (row) {
          row.current_step = input.newStep;
          row.next_due_at = input.nextDueAt;
          row.next_step_draft_json = null;
          row.next_step_drafted_at = null;
        }
        persistedDraft = null;
      },
      setCadenceDraft: (input: {
        prospectId: number;
        playName: string;
        draft: { subject: string; body: string; flags: string[]; payload: unknown };
      }) => {
        persistedDraft = { ...input.draft, draftedAt: new Date().toISOString() };
        const row = cadenceRows.find(
          (c) => c.prospect_id === input.prospectId && c.play_name === input.playName,
        );
        if (row) row.next_step_draft_json = JSON.stringify(persistedDraft);
      },
      getCadenceDraft: () => persistedDraft,
      clearCadenceDraft: () => {
        persistedDraft = null;
      },
      // The loadProspect helper in _cadence.ts pokes db.query directly; surface
      // a minimal stub that returns a fake ProspectRecord by id.
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

const { previewCadenceStep, sendCadenceStep, runCadenceStepForProspect } =
  await import("../src/_cadence.ts");
// Ensure stack-consolidation's sequence is registered.
await import("../src/stack-consolidation.ts");

function seedActiveCadence(): void {
  cadenceRows = [
    {
      prospect_id: 1,
      play_name: "stack-consolidation",
      current_step: 0,
      status: "active",
      enrolled_at: new Date().toISOString(),
      next_due_at: new Date(Date.now() - 1000).toISOString(), // overdue
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
  calls.lastSendEmailArgs = null;
  calls.lastSendEmailCtx = null;
  persistedDraft = null;
  advanceCalls.length = 0;
  sendErrorCalls.length = 0;
  throwOnSend = false;
  deferOnSend = false;
  seedActiveCadence();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("previewCadenceStep", () => {
  it("builds + persists a draft, never calls sendEmail", async () => {
    const out = await previewCadenceStep({
      prospectId: 1,
      playName: "stack-consolidation",
    });
    expect(calls.llm).toBe(1);
    expect(calls.sendEmail).toBe(0);
    expect(out.subject).toBe("fresh subject");
    expect(out.body).toBe("fresh body");
    expect(out.flags).toEqual([]); // clean draft
    expect(persistedDraft).toMatchObject({ subject: "fresh subject", body: "fresh body" });
  });

  it("refuses on a non-active cadence", async () => {
    cadenceRows[0]!.status = "replied";
    await expect(
      previewCadenceStep({ prospectId: 1, playName: "stack-consolidation" }),
    ).rejects.toThrow(/replied/);
  });

  it("refuses when no cadence exists for that pair", async () => {
    cadenceRows = [];
    await expect(
      previewCadenceStep({ prospectId: 1, playName: "stack-consolidation" }),
    ).rejects.toThrow(/no cadence/);
  });
});

describe("sendCadenceStep", () => {
  it("sends the previewed draft verbatim and advances current_step", async () => {
    await previewCadenceStep({ prospectId: 1, playName: "stack-consolidation" });
    const result = await sendCadenceStep({
      prospectId: 1,
      playName: "stack-consolidation",
    });
    expect(calls.sendEmail).toBe(1);
    expect(calls.lastSendEmailArgs).toMatchObject({
      to: "p@x.dev",
      subject: "fresh subject",
      body: "fresh body",
    });
    expect(result.action).toBe("step-sent");
    expect(advanceCalls).toHaveLength(1);
    expect(advanceCalls[0]).toMatchObject({
      prospectId: 1,
      playName: "stack-consolidation",
      newStep: 1,
    });
    // Advance clears the persisted draft (mocked side effect of advanceCadence).
    expect(persistedDraft).toBeNull();
  });

  it("refuses to send without a persisted preview", async () => {
    await expect(
      sendCadenceStep({ prospectId: 1, playName: "stack-consolidation" }),
    ).rejects.toThrow(/no persisted preview/);
  });

  it("attaches audit context (memo + decisionContext.source='cadence') to the SDK call", async () => {
    await previewCadenceStep({ prospectId: 1, playName: "stack-consolidation" });
    await sendCadenceStep({ prospectId: 1, playName: "stack-consolidation" });
    expect(calls.lastSendEmailCtx).toMatchObject({
      playName: "stack-consolidation",
      memo: expect.stringMatching(/^stack-consolidation step 1.*→ p@x\.dev$/),
      decisionContext: expect.objectContaining({
        source: "cadence",
        prospectId: 1,
        prospectEmail: "p@x.dev",
        stepIndex: 1,
      }),
    });
  });
});

describe("runCadenceStepForProspect", () => {
  it("dryRun: builds but does not send + does not advance", async () => {
    const result = await runCadenceStepForProspect({
      prospectId: 1,
      playName: "stack-consolidation",
      dryRun: true,
    });
    expect(calls.llm).toBe(1);
    expect(calls.sendEmail).toBe(0);
    expect(result.action).toBe("step-sent");
    expect(advanceCalls).toHaveLength(1); // advance still happens in dryRun (cadence state moves; just no SDK send)
  });

  it("records the send error and rethrows on a hard send failure, without advancing", async () => {
    throwOnSend = true;
    await expect(
      runCadenceStepForProspect({ prospectId: 1, playName: "stack-consolidation", dryRun: false }),
    ).rejects.toThrow(/Tool execution failed/);
    expect(sendErrorCalls).toHaveLength(1);
    expect(sendErrorCalls[0]).toMatchObject({ prospectId: 1, playName: "stack-consolidation" });
    expect(sendErrorCalls[0]!.error).toContain("Tool execution failed");
    // A failed send must NOT advance the cadence (it stays due for retry).
    expect(advanceCalls).toHaveLength(0);
  });

  it("does NOT record a send error on a daily-cap deferral (it just stays due)", async () => {
    deferOnSend = true;
    await expect(
      runCadenceStepForProspect({ prospectId: 1, playName: "stack-consolidation", dryRun: false }),
    ).rejects.toThrow(/deferred/);
    expect(sendErrorCalls).toHaveLength(0);
    expect(advanceCalls).toHaveLength(0);
  });

  it("does not record a send error on a successful send", async () => {
    await runCadenceStepForProspect({
      prospectId: 1,
      playName: "stack-consolidation",
      dryRun: false,
    });
    expect(sendErrorCalls).toHaveLength(0);
    expect(advanceCalls).toHaveLength(1);
  });

  it("skips a now-replied cadence (founder previewed then prospect replied)", async () => {
    cadenceRows[0]!.status = "replied";
    const result = await runCadenceStepForProspect({
      prospectId: 1,
      playName: "stack-consolidation",
      dryRun: false,
    });
    expect(calls.sendEmail).toBe(0);
    expect(result.action).toBe("skipped");
    expect(result.note).toContain("replied");
  });

  it("returns 'completed' action when current_step is past the last registered step", async () => {
    // stack-consolidation has 2 follow-up steps (value follow-up + breakup).
    // current_step = 2 means both have already fired; nextIndex = 3 is past
    // the end → terminal completion path.
    cadenceRows[0]!.current_step = 2;
    const result = await runCadenceStepForProspect({
      prospectId: 1,
      playName: "stack-consolidation",
      dryRun: false,
    });
    expect(result.action).toBe("completed");
    expect(calls.sendEmail).toBe(0);
    expect(calls.llm).toBe(0);
  });

  it("returns 'skipped' with 'no cadence' note when no cadence row exists", async () => {
    cadenceRows = [];
    const result = await runCadenceStepForProspect({
      prospectId: 999,
      playName: "stack-consolidation",
      dryRun: false,
    });
    expect(result.action).toBe("skipped");
    expect(result.note).toMatch(/no cadence/i);
  });

  it("returns 'skipped' with 'no registered sequence' note for unknown play", async () => {
    cadenceRows[0]!.play_name = "unknown-play";
    const result = await runCadenceStepForProspect({
      prospectId: 1,
      playName: "unknown-play",
      dryRun: false,
    });
    expect(result.action).toBe("skipped");
    expect(result.note).toMatch(/no registered sequence/i);
  });
});
