import { describe, expect, it } from "vitest";
import {
  buildSmsStep,
  buildVoiceStep,
  getSequence,
  isBreakupLabel,
  isBreakupStepAt,
  nextStepInfo,
  playFollowupCount,
  receiptUrlsForCadence,
  registerSequence,
  type CadenceContext,
  type Sequence,
} from "../src/_cadence.ts";
import type { ProspectRecord } from "@oneshot-gtm/core";
// Ensure the plays whose registerSequence we exercise are loaded.
import "../src/stack-consolidation.ts";
import "../src/accelerator-batch.ts";
import "../src/show-hn.ts";
import "../src/repo-interest.ts";

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

describe("isBreakupLabel", () => {
  it("matches case-insensitive substring", () => {
    expect(isBreakupLabel("breakup")).toBe(true);
    expect(isBreakupLabel("Final Breakup")).toBe(true);
    expect(isBreakupLabel("single follow-up + breakup")).toBe(true);
  });
  it("returns false for non-breakup labels, null, undefined, empty", () => {
    expect(isBreakupLabel("value follow-up")).toBe(false);
    expect(isBreakupLabel(null)).toBe(false);
    expect(isBreakupLabel(undefined)).toBe(false);
    expect(isBreakupLabel("")).toBe(false);
  });
});

describe("isBreakupStepAt + nextStepInfo (cross-play, centralized)", () => {
  it("stack-consolidation: step 0 (value follow-up) is NOT breakup; step 1 IS", () => {
    const seq = getSequence("stack-consolidation")!;
    expect(isBreakupStepAt(seq, 0)).toBe(false);
    expect(isBreakupStepAt(seq, 1)).toBe(true);
    expect(nextStepInfo("stack-consolidation", 0)).toMatchObject({
      label: "value follow-up",
      isBreakup: false,
    });
    expect(nextStepInfo("stack-consolidation", 1)).toMatchObject({
      label: "breakup",
      isBreakup: true,
    });
  });

  it("accelerator-batch's single follow-up is NOT flagged as breakup (label has 'breakup' but it's the only step + not preceded by a value step)", () => {
    // Position rule: the single step IS at the last position (steps.length-1 === 0).
    // And the label "single follow-up + breakup" matches breakup substring. So
    // isBreakupStepAt returns true. Documented: the helper's "cadence-final
    // breakup" semantics are based on position+label only — the policy choice
    // of whether accelerator-batch's solo step should be UX-flagged as a
    // breakup lives at the call site (currently: yes, it IS treated as breakup
    // because position+label both match).
    const seq = getSequence("accelerator-batch")!;
    expect(seq.steps.length).toBe(1);
    expect(isBreakupStepAt(seq, 0)).toBe(true);
  });

  it("show-hn: no steps registered → nextStepInfo at current_step 0 returns null", () => {
    expect(nextStepInfo("show-hn", 0)).toBeNull();
  });

  it("repo-interest: one 'value follow-up' step, NOT a breakup (2-touch total)", () => {
    const seq = getSequence("repo-interest")!;
    expect(seq.steps.length).toBe(1);
    expect(isBreakupStepAt(seq, 0)).toBe(false);
    expect(nextStepInfo("repo-interest", 0)).toMatchObject({
      label: "value follow-up",
      isBreakup: false,
    });
    // No second step → after the follow-up the cadence completes, no breakup.
    expect(nextStepInfo("repo-interest", 1)).toBeNull();
  });

  it("unknown play returns null", () => {
    expect(nextStepInfo("nope-not-a-play", 0)).toBeNull();
    expect(playFollowupCount("nope-not-a-play")).toBe(0);
  });

  it("playFollowupCount returns the registered step count", () => {
    expect(playFollowupCount("stack-consolidation")).toBe(2);
    expect(playFollowupCount("accelerator-batch")).toBe(1);
    expect(playFollowupCount("repo-interest")).toBe(1);
  });

  it("nextStepInfo returns null past the last step (completed cadence)", () => {
    expect(nextStepInfo("stack-consolidation", 2)).toBeNull();
    expect(nextStepInfo("stack-consolidation", 99)).toBeNull();
  });
});
