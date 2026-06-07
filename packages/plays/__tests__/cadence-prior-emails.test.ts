import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectRecord } from "@oneshot-gtm/core";

const llmCalls: Array<{ user: string; system: string }> = [];

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
    getLedger: () => ({
      listSequenceEventsForProspectPlay: (_pid: number, _play: string) => storedRows,
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

let storedRows: Array<{
  step_index: number;
  metadata_json: string | null;
  status?: string;
  created_at?: string;
}> = [];

const { buildFollowUpEmail, getPriorStepsForProspect } = await import("../src/_cadence.ts");

function ctx(prospectId = 42) {
  const prospect: ProspectRecord = {
    id: prospectId,
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    linkedin_url: null,
    dossier_json: null,
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
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: null,
    },
    metadata: {},
  };
}

beforeEach(() => {
  llmCalls.length = 0;
  nextLlmContent = null;
  storedRows = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildFollowUpEmail — PRIOR EMAILS injection", () => {
  it("emits prior subjects + bodies in the order the ledger returns them, with labels", async () => {
    // The ledger's ORDER BY guarantees ascending step order; the builder must
    // not re-sort. We feed rows in reverse to prove the builder preserves the
    // ledger's order rather than imposing its own — a regression catch for
    // anyone adding a defensive .sort() to the block.
    storedRows = [
      {
        step_index: 1,
        metadata_json: JSON.stringify({
          subject: "second subject",
          body: "second body content",
          label: "value follow-up",
        }),
      },
      {
        step_index: 0,
        metadata_json: JSON.stringify({
          subject: "first subject",
          body: "first body content",
        }),
      },
    ];
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "stack-consolidation-followup",
      contextLines: ["PLAY: stack-consolidation. Day-3 value follow-up."],
    });
    const out = await builder(ctx());
    expect(out).toEqual({ kind: "email", subject: "ok", body: "ok body" });
    expect(llmCalls).toHaveLength(1);
    const userMsg = llmCalls[0]!.user;
    expect(userMsg).toContain("PRIOR EMAILS");
    const firstIdx = userMsg.indexOf("step 1");
    const zeroIdx = userMsg.indexOf("step 0");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(zeroIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(zeroIdx);
    expect(userMsg).toContain("first subject");
    expect(userMsg).toContain("first body content");
    expect(userMsg).toContain("second subject");
    expect(userMsg).toContain("second body content");
    // Labels: explicit "value follow-up" for the labeled row, fallback
    // "initial send" for the step-0 row with no label.
    expect(userMsg).toContain("value follow-up");
    expect(userMsg).toContain("initial send");
  });

  it("omits the PRIOR EMAILS block when there are no usable prior rows", async () => {
    storedRows = [];
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "stack-consolidation-followup",
      contextLines: ["PLAY: x"],
    });
    await builder(ctx());
    expect(llmCalls[0]!.user).not.toContain("PRIOR EMAILS");
  });

  it("buildFollowUpEmail applies the humanizer autofix to the LLM output (em-dash → ', ', curly quotes → straight)", async () => {
    // Regression: cadence follow-ups used to skip humanizeDraft, so em-dashes
    // returned by the LLM would ship raw (lint flagged them but the body
    // still contained `layer—still`). Now buildFollowUpEmail runs the same
    // deterministic autofix that initial-send plays get via
    // draftEmailFromPrompt.
    nextLlmContent = JSON.stringify({
      subject: "stack thing",
      body: "the migration sketch for the action layer—still want it? “yes” works.",
    });
    storedRows = [];
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "stack-consolidation-followup",
      contextLines: [],
    });
    const out = await builder(ctx());
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("email");
    if (out!.kind !== "email") throw new Error("expected email payload");
    // Em-dash → ", " (autofixer's deterministic rule).
    expect(out!.body).not.toContain("—");
    expect(out!.body).toContain("layer, still");
    // Curly quotes → straight ASCII.
    expect(out!.body).not.toContain("“");
    expect(out!.body).not.toContain("”");
    expect(out!.body).toContain('"yes"');
  });

  it("skips ledger rows whose metadata has no body (graceful pre-change degrade)", async () => {
    storedRows = [
      {
        step_index: 0,
        metadata_json: JSON.stringify({ subject: "only subject, no body" }),
      },
    ];
    const builder = buildFollowUpEmail({
      playName: "stack-consolidation",
      promptName: "stack-consolidation-followup",
      contextLines: [],
    });
    await builder(ctx());
    expect(llmCalls[0]!.user).not.toContain("PRIOR EMAILS");
  });
});

describe("getPriorStepsForProspect — shared helper", () => {
  it("returns all rows with body:null on legacy (LLM filters; API surfaces with placeholder)", () => {
    storedRows = [
      {
        step_index: 0,
        metadata_json: JSON.stringify({ subject: "legacy, no body persisted" }),
        status: "sent",
        created_at: "2026-05-01T10:00:00Z",
      },
      {
        step_index: 1,
        metadata_json: JSON.stringify({
          subject: "modern row",
          body: "modern body",
          label: "value follow-up",
        }),
        status: "sent",
        created_at: "2026-05-04T10:00:00Z",
      },
    ];
    const out = getPriorStepsForProspect(42, "stack-consolidation");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      stepIndex: 0,
      subject: "legacy, no body persisted",
      body: null,
      label: "initial send",
      sentAt: "2026-05-01T10:00:00Z",
    });
    expect(out[1]).toMatchObject({
      stepIndex: 1,
      subject: "modern row",
      body: "modern body",
      label: "value follow-up",
      sentAt: "2026-05-04T10:00:00Z",
    });
  });

  it("returns empty array when prospectId is 0/falsy", () => {
    storedRows = [
      {
        step_index: 0,
        metadata_json: JSON.stringify({ subject: "x", body: "y" }),
        status: "sent",
        created_at: "2026-05-01T10:00:00Z",
      },
    ];
    expect(getPriorStepsForProspect(0, "stack-consolidation")).toEqual([]);
  });

  it("returns empty array when the ledger has no rows for this prospect+play", () => {
    storedRows = [];
    expect(getPriorStepsForProspect(42, "stack-consolidation")).toEqual([]);
  });

  it("treats null metadata_json as missing subject/body — row keeps step + sentAt", () => {
    storedRows = [
      {
        step_index: 0,
        metadata_json: null,
        status: "sent",
        created_at: "2026-05-01T10:00:00Z",
      },
    ];
    const out = getPriorStepsForProspect(42, "stack-consolidation");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      stepIndex: 0,
      subject: "(no subject)",
      body: null,
      label: "initial send",
      sentAt: "2026-05-01T10:00:00Z",
    });
  });

  it("falls back to 'follow-up' label for non-step-0 rows whose metadata lacks an explicit label", () => {
    storedRows = [
      {
        step_index: 1,
        metadata_json: JSON.stringify({ subject: "s", body: "b" }),
        status: "sent",
        created_at: "2026-05-04T10:00:00Z",
      },
    ];
    expect(getPriorStepsForProspect(42, "stack-consolidation")[0]?.label).toBe("follow-up");
  });
});
