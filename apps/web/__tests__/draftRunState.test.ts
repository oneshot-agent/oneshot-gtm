import { describe, expect, it } from "vitest";
import { reconcileGenerating } from "../src/lib/draftRunState.ts";

// MIN_VISIBLE_MS = 800, MAX_RUNTIME_MS = 5 * 60 * 1000 (kept in sync with the module).
const NOW = 1_000_000_000;

describe("reconcileGenerating", () => {
  it("keeps a freshly-started row generating while no draft has landed yet", () => {
    const out = reconcileGenerating({
      startedAtById: new Map([[1, NOW - 2000]]),
      lastDraftedAtById: new Map([[1, null]]),
      now: NOW,
    });
    expect(out.generating.has(1)).toBe(true);
    expect(out.toClear).toEqual([]);
  });

  it("clears the marker once a draft is persisted after the click (done signal)", () => {
    const out = reconcileGenerating({
      startedAtById: new Map([[1, NOW - 2000]]),
      lastDraftedAtById: new Map([[1, NOW - 100]]), // drafted AFTER start
      now: NOW,
    });
    expect(out.generating.has(1)).toBe(false);
    expect(out.toClear).toEqual([1]);
  });

  it("honors the MIN_VISIBLE floor: a sub-second draft still shows the spinner", () => {
    const out = reconcileGenerating({
      startedAtById: new Map([[1, NOW - 300]]), // 300ms ago, < 800ms floor
      lastDraftedAtById: new Map([[1, NOW - 50]]), // already drafted
      now: NOW,
    });
    expect(out.generating.has(1)).toBe(true);
    expect(out.toClear).toEqual([]);
  });

  it("does NOT treat a stale prior draft (timestamp before the click) as done", () => {
    const out = reconcileGenerating({
      startedAtById: new Map([[1, NOW - 2000]]),
      lastDraftedAtById: new Map([[1, NOW - 5000]]), // older than the click
      now: NOW,
    });
    expect(out.generating.has(1)).toBe(true);
    expect(out.toClear).toEqual([]);
  });

  it("zombie-clears a run that never completed (no draft, past MAX_RUNTIME)", () => {
    const out = reconcileGenerating({
      startedAtById: new Map([[1, NOW - 6 * 60 * 1000]]), // 6 min ago
      lastDraftedAtById: new Map([[1, null]]),
      now: NOW,
    });
    expect(out.generating.has(1)).toBe(false);
    expect(out.toClear).toEqual([1]);
  });

  it("reconciles a mix of rows independently", () => {
    const out = reconcileGenerating({
      startedAtById: new Map([
        [1, NOW - 2000], // in-flight
        [2, NOW - 2000], // done
        [3, NOW - 6 * 60 * 1000], // zombie
      ]),
      lastDraftedAtById: new Map([
        [1, null],
        [2, NOW - 100],
        [3, null],
      ]),
      now: NOW,
    });
    expect(out.generating).toEqual(new Set([1]));
    expect(out.toClear.toSorted()).toEqual([2, 3]);
  });
});
