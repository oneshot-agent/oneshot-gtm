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
      productOneLiner: "OneShot",
      productDomain: null,
      sendingDomain: null,
      icpOneLiner: null,
      cadenceOverrides: null,
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
        content: JSON.stringify({ subject: "ok", body: "ok body" }),
        provider: "test",
        model: "test",
      };
    },
  };
});

let storedRows: Array<{ step_index: number; metadata_json: string | null }> = [];

const { buildFollowUpEmail } = await import("../src/_cadence.ts");

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
      productOneLiner: "OneShot",
      productDomain: null,
      sendingDomain: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      clientId: null,
    },
    metadata: {},
  };
}

beforeEach(() => {
  llmCalls.length = 0;
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
