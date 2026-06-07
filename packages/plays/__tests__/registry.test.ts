import { describe, expect, it } from "vitest";
import { isSupportedPlay, PLAYS } from "../src/registry.ts";

// Guards the single source of truth the SSE /run dispatch and the queue drainer
// both consume. If a play is added/removed, this list must move with it — which
// is the whole point of collapsing the two old switch statements into one table.
const EXPECTED = [
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "competitor-switch",
  "stack-consolidation",
  "repo-interest",
  "luma-events",
  "breakup-revive",
];

describe("play registry", () => {
  it("registers exactly the expected plays, each with a run fn", () => {
    expect(Object.keys(PLAYS).toSorted()).toEqual(EXPECTED.toSorted());
    for (const name of EXPECTED) {
      expect(typeof PLAYS[name]?.run).toBe("function");
    }
  });

  it("isSupportedPlay matches the table membership", () => {
    expect(isSupportedPlay("show-hn")).toBe(true);
    expect(isSupportedPlay("stack-consolidation")).toBe(true);
    expect(isSupportedPlay("nope")).toBe(false);
    expect(isSupportedPlay("toString")).toBe(false); // not fooled by prototype keys
  });
});
