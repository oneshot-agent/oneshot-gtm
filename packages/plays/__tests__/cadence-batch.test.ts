import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = { sendEmail: 0, llm: 0 };

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
let persistedDrafts: Map<string, unknown> = new Map();

function k(pid: number, play: string): string {
  return `${pid}|${play}`;
}

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: "J",
      founderEmail: null,
      productOneLiner: "thing",
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
    sendEmail: async () => {
      calls.sendEmail++;
      return { receiptId: 1 };
    },
    listInbox: async () => ({ emails: [], has_more: false }),
    getLedger: () => ({
      listAllCadences: () => cadenceRows,
      listActiveCadences: () => cadenceRows.filter((c) => c.status === "active"),
      findProspectByEmail: () => null,
      listSequenceEventsForProspectPlay: () => [],
      recordSequenceEvent: () => 0,
      setCadenceStatus: () => {},
      advanceCadence: (input: { prospectId: number; playName: string; newStep: number }) => {
        const row = cadenceRows.find(
          (c) => c.prospect_id === input.prospectId && c.play_name === input.playName,
        );
        if (row) {
          row.current_step = input.newStep;
          row.next_step_draft_json = null;
        }
        persistedDrafts.delete(k(input.prospectId, input.playName));
      },
      setCadenceDraft: (input: {
        prospectId: number;
        playName: string;
        draft: { subject: string; body: string; flags: string[]; payload: unknown };
      }) => {
        persistedDrafts.set(k(input.prospectId, input.playName), {
          ...input.draft,
          draftedAt: new Date().toISOString(),
        });
        const row = cadenceRows.find(
          (c) => c.prospect_id === input.prospectId && c.play_name === input.playName,
        );
        if (row) row.next_step_draft_json = JSON.stringify(input.draft);
      },
      getCadenceDraft: (input: { prospectId: number; playName: string }) =>
        persistedDrafts.get(k(input.prospectId, input.playName)) ?? null,
      clearCadenceDraft: (input: { prospectId: number; playName: string }) => {
        persistedDrafts.delete(k(input.prospectId, input.playName));
      },
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
        content: JSON.stringify({ subject: "subj", body: "body" }),
        provider: "test",
        model: "test",
      };
    },
  };
});

const { previewCadenceStepBatch, sendCadenceStepBatch } = await import("../src/_cadence.ts");
await import("../src/stack-consolidation.ts");

beforeEach(() => {
  calls.sendEmail = 0;
  calls.llm = 0;
  persistedDrafts = new Map();
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
      prospect_email: "a@x.dev",
      prospect_name: "A",
      prospect_company: "AC",
    },
    {
      prospect_id: 2,
      play_name: "stack-consolidation",
      current_step: 0,
      status: "replied",
      enrolled_at: new Date().toISOString(),
      next_due_at: null,
      last_polled_at: null,
      next_step_draft_json: null,
      next_step_drafted_at: null,
      prospect_email: "b@x.dev",
      prospect_name: "B",
      prospect_company: "BC",
    },
    {
      prospect_id: 3,
      play_name: "stack-consolidation",
      current_step: 0,
      status: "active",
      enrolled_at: new Date().toISOString(),
      next_due_at: new Date(Date.now() - 1000).toISOString(),
      last_polled_at: null,
      next_step_draft_json: null,
      next_step_drafted_at: null,
      prospect_email: "c@x.dev",
      prospect_name: "C",
      prospect_company: "CC",
    },
  ];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("previewCadenceStepBatch", () => {
  it("processes all items; a non-active row records ok:false but the rest succeed", async () => {
    const out = await previewCadenceStepBatch([
      { prospectId: 1, playName: "stack-consolidation" },
      { prospectId: 2, playName: "stack-consolidation" },
      { prospectId: 3, playName: "stack-consolidation" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]?.ok).toBe(true);
    expect(out[1]?.ok).toBe(false);
    expect(out[1]?.error).toMatch(/replied/);
    expect(out[2]?.ok).toBe(true);
    // 2 LLM calls (skipped the replied one).
    expect(calls.llm).toBe(2);
    expect(calls.sendEmail).toBe(0);
  });

  it("never throws — even when every item fails", async () => {
    cadenceRows.forEach((c) => (c.status = "completed"));
    const out = await previewCadenceStepBatch([
      { prospectId: 1, playName: "stack-consolidation" },
      { prospectId: 3, playName: "stack-consolidation" },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => !r.ok)).toBe(true);
    expect(calls.sendEmail).toBe(0);
  });
});

describe("sendCadenceStepBatch", () => {
  it("serial: each row sends in input order using its persisted draft", async () => {
    // Pre-seed previews so send can proceed.
    persistedDrafts.set(k(1, "stack-consolidation"), {
      subject: "s1",
      body: "b1",
      flags: [],
      payload: { kind: "email", subject: "s1", body: "b1" },
      draftedAt: new Date().toISOString(),
    });
    persistedDrafts.set(k(3, "stack-consolidation"), {
      subject: "s3",
      body: "b3",
      flags: [],
      payload: { kind: "email", subject: "s3", body: "b3" },
      draftedAt: new Date().toISOString(),
    });

    const out = await sendCadenceStepBatch([
      { prospectId: 1, playName: "stack-consolidation" },
      { prospectId: 3, playName: "stack-consolidation" },
    ]);

    expect(out).toHaveLength(2);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(calls.sendEmail).toBe(2);
  });

  it("missing preview is captured as a per-row error; others still send", async () => {
    persistedDrafts.set(k(3, "stack-consolidation"), {
      subject: "s3",
      body: "b3",
      flags: [],
      payload: { kind: "email", subject: "s3", body: "b3" },
      draftedAt: new Date().toISOString(),
    });

    const out = await sendCadenceStepBatch([
      { prospectId: 1, playName: "stack-consolidation" }, // no preview persisted
      { prospectId: 3, playName: "stack-consolidation" },
    ]);

    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.error).toMatch(/no persisted preview/);
    expect(out[1]?.ok).toBe(true);
    expect(calls.sendEmail).toBe(1);
  });

  it("never throws", async () => {
    const out = await sendCadenceStepBatch([
      { prospectId: 1, playName: "stack-consolidation" },
      { prospectId: 2, playName: "stack-consolidation" },
    ]);
    expect(out.every((r) => !r.ok)).toBe(true);
  });

  it("fires onItemSettled per item, in order, with the matching result", async () => {
    persistedDrafts.set(k(1, "stack-consolidation"), {
      subject: "s1",
      body: "b1",
      flags: [],
      payload: { kind: "email", subject: "s1", body: "b1" },
      draftedAt: new Date().toISOString(),
    });
    persistedDrafts.set(k(3, "stack-consolidation"), {
      subject: "s3",
      body: "b3",
      flags: [],
      payload: { kind: "email", subject: "s3", body: "b3" },
      draftedAt: new Date().toISOString(),
    });

    const settledOrder: Array<{ pid: number; ok: boolean }> = [];
    await sendCadenceStepBatch(
      [
        { prospectId: 1, playName: "stack-consolidation" },
        { prospectId: 2, playName: "stack-consolidation" }, // 'replied' → no draft → fails
        { prospectId: 3, playName: "stack-consolidation" },
      ],
      (item, result) => {
        settledOrder.push({ pid: item.prospectId, ok: result.ok });
      },
    );

    expect(settledOrder).toEqual([
      { pid: 1, ok: true },
      { pid: 2, ok: false },
      { pid: 3, ok: true },
    ]);
  });
});
