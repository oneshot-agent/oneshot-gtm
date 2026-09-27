import { beforeEach, describe, expect, it, vi } from "vitest";

// `angleAssignment: "arm"`: each prospect gets one angle by an even, stable
// split of their email instead of by the fit classifier, and keeps it
// through the follow-ups, so a trigger's angles can be compared like for
// like. Off (absent / "fit") everything is unchanged.

const A = "For a founder selling to clinics — the data breaks before the copy does";
const B = "For a CTO shipping agents — egress is the hole in the sandbox";
const C = "For a growth lead — the second touch re-sends the first argument";
const D = "For a batch founder — the stars on your repo are the warmest list";
const EDGE4 = `${A} // ${B} // ${C} // ${D}`;

let sentRow: { payload: Record<string, unknown>; source: string } | null = null;
let triggerConfig: Record<string, unknown> | null = null;
let introAngleText: string | null = null;
const cache = new Map<string, string>();
let classifierCalls = 0;

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
  // The fit classifier always answers the first candidate it is shown.
  return {
    ...actual,
    loadPrompt: () => "choose",
    complete: async () => {
      classifierCalls += 1;
      return { content: '{"index":1}' };
    },
  };
});

const {
  angleArmIndex,
  angleAssignmentOf,
  followUpEdgeBlock,
  followUpEdgeSelection,
  hashPick,
  selectAngle,
  splitEdgeAngles,
} = await import("../src/_angles.ts");
const { firstTouchArm } = await import("../src/_first-touch.ts");
const { resolveTriggerOverlay } = await import("@oneshot-gtm/core");

beforeEach(() => {
  cache.clear();
  classifierCalls = 0;
  sentRow = null;
  triggerConfig = null;
  introAngleText = null;
});

describe("angleAssignmentOf", () => {
  it("is arm only for the exact value; anything else is fit", () => {
    expect(angleAssignmentOf({ angleAssignment: "arm" })).toBe("arm");
    expect(angleAssignmentOf({ angleAssignment: "fit" })).toBe("fit");
    expect(angleAssignmentOf({ angleAssignment: "ARM" })).toBe("fit");
    expect(angleAssignmentOf({})).toBe("fit");
  });
});

describe("selectAngle with assignment arm", () => {
  it("splits 1,000 prospects across four angles within ±10% of an even share", async () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) {
      const pick = await selectAngle({
        edge: EDGE4,
        prospectKey: `person${i}@company${i % 37}.com`,
        description: "",
        assignment: "arm",
      });
      expect(pick.method).toBe("arm");
      counts[pick.index]! += 1;
    }
    for (const n of counts) {
      expect(n).toBeGreaterThanOrEqual(225);
      expect(n).toBeLessThanOrEqual(275);
    }
    // No model is asked, and nothing is cached: the split is the decision.
    expect(classifierCalls).toBe(0);
    expect(cache.size).toBe(0);
  });

  it("stays balanced for a two- and a three-angle edge", async () => {
    for (const count of [2, 3]) {
      const counts = Array.from({ length: count }, () => 0);
      for (let i = 0; i < 1000; i++) counts[angleArmIndex(`lead-${i}@example.org`, count)]! += 1;
      const even = 1000 / count;
      for (const n of counts) {
        expect(n).toBeGreaterThanOrEqual(even * 0.9);
        expect(n).toBeLessThanOrEqual(even * 1.1);
      }
    }
  });

  it("is stable per prospect, whatever the case or spacing of the email", async () => {
    const first = await selectAngle({
      edge: EDGE4,
      prospectKey: "Jane@Example.com",
      description: "a",
      assignment: "arm",
    });
    const again = await selectAngle({
      edge: EDGE4,
      prospectKey: "  jane@example.com ",
      description: "something else entirely",
      assignment: "arm",
    });
    expect(again.index).toBe(first.index);
    expect(again.angle).toBe(first.angle);
  });

  it("is independent of the first-touch format arm and the fit fallback hash", () => {
    // Same emails, independent splits: across many prospects the angle arm
    // must not follow the format arm (#713) or the unsalted fallback pick.
    let sameAsFormat = 0;
    let sameAsFallback = 0;
    for (let i = 0; i < 1000; i++) {
      const email = `p${i}@x.dev`;
      const angleHalf = angleArmIndex(email, 2);
      const formatHalf = firstTouchArm({ firstTouchFormat: "split" }, email) === "brief" ? 0 : 1;
      if (angleHalf === formatHalf) sameAsFormat += 1;
      if (angleHalf === hashPick(email, 2, null)) sameAsFallback += 1;
    }
    for (const same of [sameAsFormat, sameAsFallback]) {
      expect(same).toBeGreaterThan(430);
      expect(same).toBeLessThan(570);
    }
  });

  it("a one-angle edge is still a single pick, not an arm", async () => {
    const pick = await selectAngle({
      edge: A,
      prospectKey: "p@x.dev",
      description: "",
      assignment: "arm",
    });
    expect(pick).toMatchObject({ index: 0, count: 1, method: "single" });
  });
});

describe("selectAngle without arm", () => {
  it("is unchanged: the fit classifier decides and the pick is cached", async () => {
    const pick = await selectAngle({ edge: EDGE4, prospectKey: "p@x.dev", description: "cto" });
    expect(pick.method).toBe("classifier");
    expect(classifierCalls).toBe(1);
    expect(cache.size).toBe(1);
    const fit = await selectAngle({
      edge: EDGE4,
      prospectKey: "p@x.dev",
      description: "cto",
      assignment: "fit",
    });
    expect(fit.method).toBe("cached");
    expect(fit.index).toBe(pick.index);
  });
});

describe("follow-ups under the arm split", () => {
  const prospect = { email: "p@x.dev", id: 7 };

  it("keeps the intro's angle instead of switching to a new one", async () => {
    sentRow = { payload: { email: "p@x.dev", yourEdge: EDGE4 }, source: "find:luma-events" };
    triggerConfig = { yourEdge: EDGE4, angleAssignment: "arm" };
    introAngleText = C;
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel).toMatchObject({ angle: C, index: 2, count: 4, method: "arm" });
    expect(classifierCalls).toBe(0);
  });

  it("follows the intro's angle by text when the edge was reordered", async () => {
    sentRow = { payload: { email: "p@x.dev", yourEdge: EDGE4 }, source: "find:luma-events" };
    triggerConfig = { yourEdge: `${D} // ${C} // ${B} // ${A}`, angleAssignment: "arm" };
    introAngleText = C;
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel).toMatchObject({ angle: C, index: 1, method: "arm" });
  });

  it("uses the prospect's arm on the current edge when the intro's angle is gone", async () => {
    sentRow = { payload: { email: "p@x.dev", yourEdge: EDGE4 }, source: "find:luma-events" };
    triggerConfig = { yourEdge: `${B} // ${C} // ${D}`, angleAssignment: "arm" };
    introAngleText = "an angle that was rewritten away";
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    const expected = angleArmIndex("p@x.dev", 3);
    expect(sel).toMatchObject({ index: expected, method: "arm" });
    expect(sel?.angle).toBe(splitEdgeAngles(`${B} // ${C} // ${D}`)[expected]);
  });

  it("a founder's rotate leaves the arm through the fit path", async () => {
    sentRow = { payload: { email: "p@x.dev", yourEdge: EDGE4 }, source: "find:luma-events" };
    triggerConfig = { yourEdge: `${A} // ${B} // ${C}`, angleAssignment: "arm" };
    introAngleText = A;
    const sel = await followUpEdgeSelection(prospect, "luma-events", { rotateFrom: A });
    expect(sel?.method).not.toBe("arm");
    expect(sel?.angle).not.toBe(A);
  });

  it("without the option, the follow-up still takes a different angle", async () => {
    sentRow = {
      payload: { email: "p@x.dev", yourEdge: `${A} // ${B}` },
      source: "find:luma-events",
    };
    triggerConfig = { yourEdge: `${A} // ${B}` };
    introAngleText = A;
    const sel = await followUpEdgeSelection(prospect, "luma-events");
    expect(sel?.angle).toBe(B);
    expect(sel?.method).not.toBe("arm");
  });

  it("asks for new material on the same angle, not a new angle", () => {
    const same = followUpEdgeBlock(A, { sameAsIntro: true });
    expect(same).toContain("the same angle as the first email");
    expect(same).toContain(A);
    expect(followUpEdgeBlock(A)).toContain("a different angle from the first email");
  });
});

/** A `getTrigger` double that returns one trigger row with this config. */
function get(config: Record<string, unknown>) {
  return () => ({ config_json: JSON.stringify(config) });
}

describe("resolveTriggerOverlay carries angleAssignment", () => {
  it("copies arm from the trigger's current config", () => {
    const out = resolveTriggerOverlay(
      { email: "p@x.dev", yourEdge: EDGE4 },
      "find:luma-events",
      get({ yourEdge: EDGE4, angleAssignment: "arm" }) as never,
    );
    expect(out["angleAssignment"]).toBe("arm");
  });

  it("drops a stale or invalid value so the row falls back to fit", () => {
    const out = resolveTriggerOverlay(
      { email: "p@x.dev", yourEdge: EDGE4, angleAssignment: "arm" },
      "find:luma-events",
      get({ yourEdge: EDGE4, angleAssignment: "sometimes" }) as never,
    );
    expect(out["angleAssignment"]).toBeUndefined();
  });
});
