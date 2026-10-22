import { beforeEach, describe, expect, it, vi } from "vitest";

// Follow-ups pick from the trigger's CURRENT edge and exclude the intro's
// angle by its recorded text; "Rotate angle" also excludes the angle being
// rotated away from.

const A = "For a founder selling to clinics — the data breaks before the copy does";
const B = "For a CTO shipping agents — egress is the hole in the sandbox";
const C = "For a growth lead — the second touch re-sends the first argument";
const D = "For a batch founder — the stars on your repo are the warmest list";

let sentRow: { payload: Record<string, unknown>; source: string } | null = null;
/** The offer the cadence carries (`offer_json`), when it has one. */
let seqOffer: Record<string, unknown> | null = null;
let triggerConfig: Record<string, unknown> | null = null;
let introAngleText: string | null = null;
/** The sequence's sent steps, when a test needs more than the intro. */
let priorRows: Array<{ step_index: number; status?: string; metadata_json: string }> | null = null;
const cache = new Map<string, string>();
const classifierInputs: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    loadConfig: () => ({ founderName: "F", productOneLiner: "p" }),
    getLedger: () => ({
      cadenceQueueRow: () => (sentRow ? { id: 1, ...sentRow } : null),
      getCadence: () => ({
        queue_id: sentRow ? 1 : null,
        offer_json: seqOffer
          ? JSON.stringify({ offer: seqOffer, candidates: [], origin: "intro" })
          : null,
      }),
      getTrigger: () =>
        triggerConfig ? { config_json: JSON.stringify(triggerConfig) } : undefined,
      listSequenceEventsForProspectPlay: () =>
        priorRows ??
        (introAngleText
          ? [{ step_index: 0, metadata_json: JSON.stringify({ angleText: introAngleText }) }]
          : []),
      getProductResearchCache: (k: string) => cache.get(k) ?? null,
      setProductResearchCache: (k: string, v: string) => void cache.set(k, v),
    }),
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  // The classifier always picks the first candidate it is shown.
  return {
    ...actual,
    loadPrompt: () => "choose",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      classifierInputs.push(input.messages.find((m) => m.role === "user")?.content ?? "");
      return { content: '{"index":1}' };
    },
  };
});

const { followUpEdgeBlock, followUpEdgeSelection } = await import("../src/_angles.ts");
const prospect = { email: "p@x.dev", id: 7 };

beforeEach(() => {
  cache.clear();
  sentRow = { payload: { email: "p@x.dev", yourEdge: `${A} // ${B}` }, source: "find:luma-events" };
  seqOffer = null;
  triggerConfig = null;
  introAngleText = A;
  priorRows = null;
  classifierInputs.length = 0;
});

/** A sent step built on `angle`. */
const sent = (step: number, angle: string) => ({
  step_index: step,
  status: "sent",
  metadata_json: JSON.stringify({ subject: "s", body: "b", angleText: angle }),
});

describe("followUpEdgeSelection across a sequence", () => {
  beforeEach(() => {
    triggerConfig = { yourEdge: `${A} // ${B} // ${C} // ${D}` };
  });

  it("step 2 takes an angle neither step 0 nor step 1 made", async () => {
    // The production case: step 1 re-ran step 0's exclusion only, and step 2
    // replayed step 1's cached pick.
    priorRows = [sent(0, A), sent(1, C)];
    const sel = await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 2 });
    expect(sel?.angle).not.toBe(A);
    expect(sel?.angle).not.toBe(C);
    expect(sel).toMatchObject({ angle: B, index: 1, count: 4, sameAsIntro: false });
    expect(sel?.usedAtStep).toBeUndefined();
    // The classifier was shown only the two unused angles.
    expect(classifierInputs.at(-1)).toContain(B);
    expect(classifierInputs.at(-1)).toContain(D);
    expect(classifierInputs.at(-1)).not.toContain(C);
  });

  it("keys the cached pick by the step, so a later step never replays an earlier one", async () => {
    priorRows = [sent(0, A)];
    await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 1 });
    priorRows = [sent(0, A), sent(1, B)];
    const second = await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 2 });
    expect([...cache.keys()].some((k) => k.endsWith(":step-1"))).toBe(true);
    expect([...cache.keys()].some((k) => k.endsWith(":step-2"))).toBe(true);
    expect(second?.angle).toBe(C);
  });

  it("does not count the step being drafted, or later ones, as earlier", async () => {
    priorRows = [sent(0, A), sent(1, B), sent(2, C)];
    const sel = await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 2 });
    expect(sel?.angle).toBe(C);
  });

  it("with every angle used, takes the least recently used one and says when", async () => {
    triggerConfig = { yourEdge: `${A} // ${B}` };
    priorRows = [sent(0, A), sent(1, B), sent(2, A)];
    const sel = await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 3 });
    expect(sel).toMatchObject({
      angle: B,
      method: "reused",
      usedAtStep: 1,
      sameAsIntro: false,
    });
    // The block never claims a used angle is new.
    const block = followUpEdgeBlock(sel!.angle, { usedAtStep: sel!.usedAtStep ?? null });
    expect(block).not.toContain("NOT raised in PRIOR EMAILS");
    expect(block).toContain("already made");
    expect(followUpEdgeBlock(D)).toContain("NOT raised in PRIOR EMAILS");
  });

  it("draws on the sequence offer's angles, with origin offer, even with no sent row", async () => {
    sentRow = null;
    priorRows = [sent(0, A)];
    const sel = await followUpEdgeSelection(prospect, "luma-events", {
      stepIndex: 1,
      offer: { angles: [A, C, D] },
    });
    expect(sel).toMatchObject({ angle: C, origin: "offer", count: 3 });
    const fromEdge = await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 1 });
    expect(fromEdge).toBeNull();
  });

  it("names the trigger's edge as configured", async () => {
    priorRows = [sent(0, A)];
    const sel = await followUpEdgeSelection(prospect, "luma-events", { stepIndex: 1 });
    expect(sel?.origin).toBe("configured");
  });
});

describe("followUpEdgeSelection", () => {
  it("picks from the cadence offer's angles, over the trigger's edge, never the intro's own", async () => {
    triggerConfig = { yourEdge: `${C} // ${D}` };
    sentRow = { payload: { email: "p@x.dev", yourEdge: A }, source: "find:luma-events" };
    seqOffer = { offer: "o", steps: "s", angles: [A, B, C] };
    introAngleText = A;
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel).toMatchObject({ angle: B, index: 1, count: 3, origin: "offer" });
  });

  it("never draws on the row's own copy of an offer the cadence replaced", async () => {
    triggerConfig = { yourEdge: `${C} // ${D}` };
    sentRow = {
      payload: {
        email: "p@x.dev",
        yourEdge: A,
        offer: { offer: "old", steps: "s", angles: [A, B] },
      },
      source: "find:luma-events",
    };
    introAngleText = C;
    // No offer on the cadence: the trigger's edge, never the row's offer.
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel).toMatchObject({ angle: D, origin: "configured" });
  });

  it("picks from the trigger's current edge, not the frozen one", async () => {
    triggerConfig = { yourEdge: `${C} // ${D}` };
    introAngleText = C;
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel).toMatchObject({ angle: D, index: 1, count: 2 });
  });

  it("excludes the intro's angle by text even when the edge was reordered", async () => {
    triggerConfig = { yourEdge: `${B} // ${A}` };
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel?.angle).toBe(B);
  });

  it("excludes nothing when the intro's angle was rewritten away", async () => {
    triggerConfig = { yourEdge: `${C} // ${D}` };
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel?.angle).toBe(C);
  });

  it("falls back to the frozen edge when the trigger has no config", async () => {
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel?.angle).toBe(B);
  });

  it("rotating excludes the current preview's angle as well as the intro's", async () => {
    triggerConfig = { yourEdge: `${A} // ${B} // ${C}` };
    const sel = await followUpEdgeSelection(prospect, "luma-events", { rotateFrom: B });
    expect(sel?.angle).toBe(C);
    expect(sel?.sameAsIntro).toBe(false);
  });

  it("rotating with only the intro's angle left uses it rather than nothing", async () => {
    triggerConfig = { yourEdge: `${A} // ${B}` };
    const sel = await followUpEdgeSelection(prospect, "luma-events", { rotateFrom: B });
    expect(sel?.angle).toBe(A);
    // Back on the intro's angle: the draft must not be told, or show, it's a new one.
    expect(sel?.sameAsIntro).toBe(true);
  });

  it("judges the intro row's demo day at follow-up time, for the classifier", async () => {
    classifierInputs.length = 0;
    sentRow = {
      payload: { email: "p@x.dev", cohort: "yc-w26", yourEdge: `${A} // ${B} // ${C}` },
      source: "find:accelerator-batch",
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    try {
      await followUpEdgeSelection(prospect, "accelerator-batch");
    } finally {
      vi.useRealTimers();
    }
    expect(classifierInputs[0]).toContain("demoDay: March 2026 (passed, ~6 months ago)");
  });

  it("returns null for a one-angle current edge", async () => {
    triggerConfig = { yourEdge: A };
    expect(await followUpEdgeSelection(prospect, "luma-events")).toBeNull();
  });
});
