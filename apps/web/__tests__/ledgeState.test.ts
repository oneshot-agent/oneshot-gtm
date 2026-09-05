import { describe, expect, it } from "vitest";
import {
  INITIAL_LEDGE,
  ledgePose,
  ledgeReducer,
  type LedgeEvent,
  type LedgeState,
} from "../src/lib/ledgeState.ts";

const observe = (
  state: LedgeState,
  replies: number | null,
  extra: Partial<Extract<LedgeEvent, { type: "observe" }>> = {},
) =>
  ledgeReducer(state, {
    type: "observe",
    workspace: "demo",
    replies,
    working: false,
    animate: true,
    ...extra,
  });
const loaded = () => ledgeReducer(observe(INITIAL_LEDGE, 19), { type: "settle" });

describe("Ledge's reactions to real observations", () => {
  it("greets once after loading without celebrating existing replies", () => {
    const loading = observe(INITIAL_LEDGE, null);
    const first = observe(loading, 19);
    expect(first.action).toBe("wave");
    expect(observe(ledgeReducer(first, { type: "settle" }), 19).action).toBeNull();
  });

  it("acknowledges a count increase once, then resumes work", () => {
    const state = observe(loaded(), 20, { working: true });
    expect(ledgePose(state, true)).toBe("reply");
    const settled = ledgeReducer(state, { type: "settle" });
    expect(ledgePose(observe(settled, 20, { working: true }), true)).toBe("working");
    expect(ledgePose(observe(settled, 20), true)).toBe("idle");
  });

  it("does not celebrate rolling-window decreases", () => {
    expect(observe(loaded(), 18).action).toBeNull();
  });

  it("rebaselines after failure and workspace changes", () => {
    const failed = observe(loaded(), null, { working: true });
    expect(failed.working).toBe(false);
    expect(observe(failed, 24).action).toBeNull();
    expect(observe(loaded(), 30, { workspace: "other" }).action).toBeNull();
  });

  it("consumes observations silently while paused, reduced, or hidden", () => {
    const paused = observe(loaded(), 22, { working: true, animate: false });
    expect(paused.action).toBeNull();
    expect(ledgePose(paused, false)).toBe("working");
    expect(observe(paused, 22).action).toBeNull();
    expect(observe(INITIAL_LEDGE, 19, { animate: false }).greeted).toBe(true);
  });

  it("lets a reply take priority over a wave", () => {
    const reply = observe(loaded(), 20);
    expect(ledgeReducer(reply, { type: "wave" }).action).toBe("reply");
    expect(ledgeReducer(loaded(), { type: "wave" }).action).toBe("wave");
  });
});
