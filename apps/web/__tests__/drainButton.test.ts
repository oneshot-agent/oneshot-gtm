import { describe, expect, it } from "vitest";
import { drainButtonState, drainSelectionState } from "../src/lib/drainButton";

const RUNNABLE = new Set(["luma-events", "repo-interest", "show-hn"]);
const state = (playFilter: string, approvedByPlay: Record<string, number> = {}) =>
  drainButtonState({ playFilter, approvedByPlay, isRunnable: (p) => RUNNABLE.has(p) });

describe("drainButtonState", () => {
  it("asks for a play when the filter is 'all'", () => {
    const out = state("all", { "luma-events": 145 });
    expect(out.enabled).toBe(false);
    expect(out.playName).toBeNull();
    expect(out.label).toBe("drain — pick a play above");
  });

  it("enables with the whole-queue count for the filtered play", () => {
    const out = state("luma-events", { "luma-events": 145, "repo-interest": 35 });
    expect(out).toEqual({
      playName: "luma-events",
      approvedCount: 145,
      enabled: true,
      label: "drain luma-events · 145",
    });
  });

  it("says why it's disabled when the play has nothing approved", () => {
    // Absent from the map (the server omits zero-count plays) reads as 0.
    const out = state("show-hn", { "luma-events": 145 });
    expect(out.enabled).toBe(false);
    expect(out.label).toBe("drain show-hn · nothing approved");
  });

  it("refuses a play with no /run schema, even when rows are approved", () => {
    const out = state("concierge", { concierge: 12 });
    expect(out.enabled).toBe(false);
    expect(out.label).toBe("drain concierge · not runnable here");
  });
});

describe("drainSelectionState", () => {
  const sel = (rows: Array<[number, string, string]>) =>
    drainSelectionState({
      selected: rows.map(([id, playName, status]) => ({ id, playName, status })),
      isRunnable: (p) => RUNNABLE.has(p),
    });

  it("drains a single-play approved selection", () => {
    const out = sel([
      [1, "luma-events", "approved"],
      [2, "luma-events", "approved"],
    ]);
    expect(out).toEqual({
      playName: "luma-events",
      ids: [1, 2],
      enabled: true,
      label: "drain 2 selected",
    });
  });

  it("ignores non-approved rows in the selection", () => {
    const out = sel([
      [1, "luma-events", "approved"],
      [2, "luma-events", "pending"],
      [3, "luma-events", "sent"],
    ]);
    expect(out.ids).toEqual([1]);
    expect(out.label).toBe("drain 1 selected");
  });

  it("refuses a selection spanning plays rather than draining a subset", () => {
    const out = sel([
      [1, "luma-events", "approved"],
      [2, "repo-interest", "approved"],
    ]);
    expect(out.enabled).toBe(false);
    expect(out.ids).toEqual([]);
    expect(out.label).toBe("drain selected · spans 2 plays");
  });

  it("counts only approved rows when deciding whether plays are mixed", () => {
    // The repo-interest row is pending, so this is NOT a mixed batch.
    const out = sel([
      [1, "luma-events", "approved"],
      [2, "repo-interest", "pending"],
    ]);
    expect(out).toMatchObject({ playName: "luma-events", ids: [1], enabled: true });
  });

  it("disables when nothing selected is approved", () => {
    expect(sel([[1, "luma-events", "pending"]])).toMatchObject({
      enabled: false,
      label: "drain selected · none approved",
    });
  });

  it("disables for a play /run can't drive", () => {
    expect(sel([[1, "concierge", "approved"]])).toMatchObject({
      enabled: false,
      label: "drain selected · not runnable here",
    });
  });
});
