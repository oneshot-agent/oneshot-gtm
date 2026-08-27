import { describe, expect, it } from "vitest";
import { withXEngine } from "../src/index.ts";

const CONFIG = {
  engine: "twitterapiio",
  seeds: [{ handle: "iamdevloper" }],
  launchDate: "2026-10-06",
  laneSplit: 0.5,
  limit: 12,
  maxSpendPerRun: 1,
  knobs: { maxPerTweet: 50 },
};

describe("withXEngine", () => {
  it("drops the per-engine overrides ONLY when the engine actually changes", () => {
    const flipped = withXEngine(CONFIG, "xapi");
    expect(flipped["engine"]).toBe("xapi");
    // Carrying twitterapi.io's $1 ceiling onto the X API buys ~100 user reads
    // and stalls the run — the registry's per-engine defaults must re-apply.
    expect(flipped).not.toHaveProperty("maxSpendPerRun");
    expect(flipped).not.toHaveProperty("knobs");
  });

  it("keeps explicit overrides on a same-engine write", () => {
    const same = withXEngine(CONFIG, "twitterapiio");
    expect(same["maxSpendPerRun"]).toBe(1);
    expect(same["knobs"]).toEqual({ maxPerTweet: 50 });
  });

  it("preserves everything else", () => {
    const flipped = withXEngine(CONFIG, "xapi");
    expect(flipped["seeds"]).toEqual([{ handle: "iamdevloper" }]);
    expect(flipped["launchDate"]).toBe("2026-10-06");
    expect(flipped["laneSplit"]).toBe(0.5);
    expect(flipped["limit"]).toBe(12);
  });

  it("does not mutate its input", () => {
    const before = structuredClone(CONFIG);
    withXEngine(CONFIG, "xapi");
    expect(CONFIG).toEqual(before);
  });

  it("tolerates a null/absent config", () => {
    expect(withXEngine(null, "xapi")).toEqual({ engine: "xapi" });
    expect(withXEngine(undefined, "twitterapiio")).toEqual({ engine: "twitterapiio" });
  });
});
