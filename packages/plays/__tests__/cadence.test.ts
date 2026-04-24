import { describe, expect, it } from "vitest";
import {
  buildSmsStep,
  buildVoiceStep,
  getSequence,
  receiptUrlsForCadence,
  registerSequence,
  type CadenceContext,
  type Sequence,
} from "../src/_cadence.ts";
import type { ProspectRecord } from "@oneshot-gtm/core";

function makeCtx(overrides: Partial<ProspectRecord> = {}): CadenceContext {
  const prospect: ProspectRecord = {
    id: 1,
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    linkedin_url: null,
    dossier_json: null,
    source: "test",
    created_at: new Date().toISOString(),
    ...overrides,
  } as ProspectRecord;
  return {
    prospect,
    cfg: {
      walletMode: "cdp",
      llmProvider: "openrouter",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: "J",
      founderEmail: null,
      productOneLiner: "does X",
      icpOneLiner: null,
      clientId: null,
    },
    metadata: {},
  };
}

describe("sequence registry", () => {
  it("registerSequence + getSequence round-trips by play name", () => {
    const seq: Sequence = {
      playName: "__test-seq-" + Math.random().toString(36).slice(2),
      steps: [
        {
          dayOffset: 3,
          channel: "email",
          breakOnReply: true,
          builder: async () => null,
        },
      ],
    };
    registerSequence(seq);
    expect(getSequence(seq.playName)).toBe(seq);
  });

  it("getSequence returns undefined for unknown names", () => {
    expect(getSequence("__never-registered-" + Date.now())).toBeUndefined();
  });

  it("registerSequence replaces a prior registration under the same name", () => {
    const name = "__test-replace-" + Math.random().toString(36).slice(2);
    const first: Sequence = {
      playName: name,
      steps: [{ dayOffset: 1, channel: "email", breakOnReply: true, builder: async () => null }],
    };
    const second: Sequence = {
      playName: name,
      steps: [
        { dayOffset: 5, channel: "email", breakOnReply: true, builder: async () => null },
        { dayOffset: 9, channel: "email", breakOnReply: true, builder: async () => null },
      ],
    };
    registerSequence(first);
    registerSequence(second);
    expect(getSequence(name)?.steps).toHaveLength(2);
  });
});

describe("buildSmsStep", () => {
  it("returns null without calling the LLM when toPhone yields null", async () => {
    const builder = buildSmsStep({
      promptName: "this-should-never-be-loaded",
      contextLines: [],
      toPhone: () => null,
    });
    // If the LLM path were reached, loadPrompt would throw on the bogus name.
    await expect(builder(makeCtx())).resolves.toBeNull();
  });
});

describe("buildVoiceStep", () => {
  it("returns null when toPhone is null (skips dispatch entirely)", async () => {
    const builder = buildVoiceStep({
      toPhone: () => null,
      objective: () => "shouldn't matter",
    });
    await expect(builder(makeCtx())).resolves.toBeNull();
  });

  it("builds a voice payload with phone + objective (no LLM needed)", async () => {
    const builder = buildVoiceStep({
      toPhone: () => "+15550000000",
      objective: (ctx) => `call ${ctx.prospect.name}`,
      maxDurationMinutes: 4,
    });
    const out = await builder(makeCtx({ name: "Sam" }));
    expect(out).toEqual({
      kind: "voice",
      toPhone: "+15550000000",
      objective: "call Sam",
      maxDurationMinutes: 4,
    });
  });

  it("includes context when provided", async () => {
    const builder = buildVoiceStep({
      toPhone: () => "+15550000000",
      objective: () => "obj",
      context: (ctx) => `at ${ctx.prospect.company}`,
    });
    const out = await builder(makeCtx());
    expect(out).toMatchObject({ kind: "voice", context: "at Acme" });
  });
});

describe("receiptUrlsForCadence", () => {
  it("maps receipt ids to local receipt URLs", () => {
    expect(receiptUrlsForCadence([1, 42])).toEqual(["local://receipt/1", "local://receipt/42"]);
  });

  it("returns an empty array for no receipts", () => {
    expect(receiptUrlsForCadence([])).toEqual([]);
  });
});
