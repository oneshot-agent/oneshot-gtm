import { beforeEach, describe, expect, it, vi } from "vitest";

// Follow-ups pick from the trigger's CURRENT edge and exclude the intro's
// angle by its recorded text; "Rotate angle" also excludes the angle being
// rotated away from.

const A = "For a founder selling to clinics — the data breaks before the copy does";
const B = "For a CTO shipping agents — egress is the hole in the sandbox";
const C = "For a growth lead — the second touch re-sends the first argument";
const D = "For a batch founder — the stars on your repo are the warmest list";

let sentRow: { payload: Record<string, unknown>; source: string } | null = null;
let triggerConfig: Record<string, unknown> | null = null;
let introAngleText: string | null = null;
const cache = new Map<string, string>();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    loadConfig: () => ({ founderName: "F", productOneLiner: "p" }),
    getLedger: () => ({
      latestSentQueueRow: () => sentRow,
      latestSentQueuePayload: () => sentRow?.payload ?? null,
      getTrigger: () =>
        triggerConfig ? { config_json: JSON.stringify(triggerConfig) } : undefined,
      listSequenceEventsForProspectPlay: () =>
        introAngleText
          ? [{ step_index: 0, metadata_json: JSON.stringify({ angleText: introAngleText }) }]
          : [],
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
    complete: async () => ({ content: '{"index":1}' }),
  };
});

const { followUpEdgeSelection } = await import("../src/_angles.ts");
const prospect = { email: "p@x.dev", id: 7 };

beforeEach(() => {
  cache.clear();
  sentRow = { payload: { email: "p@x.dev", yourEdge: `${A} // ${B}` }, source: "find:luma-events" };
  triggerConfig = null;
  introAngleText = A;
});

describe("followUpEdgeSelection", () => {
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
  });

  it("rotating with only the intro's angle left uses it rather than nothing", async () => {
    triggerConfig = { yourEdge: `${A} // ${B}` };
    const sel = await followUpEdgeSelection(prospect, "luma-events", { rotateFrom: B });
    expect(sel?.angle).toBe(A);
  });

  it("returns null for a one-angle current edge", async () => {
    triggerConfig = { yourEdge: A };
    expect(await followUpEdgeSelection(prospect, "luma-events")).toBeNull();
  });
});
