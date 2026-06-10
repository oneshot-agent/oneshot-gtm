import { describe, expect, it } from "vitest";
import {
  INTERVAL_PRESETS_MS,
  MIN_INTERVAL_MS,
  withIntervalOverride,
} from "../src/lib/triggerInterval";

describe("withIntervalOverride", () => {
  it("sets intervalMs while preserving the trigger's other config keys", () => {
    const config = { topics: ["AI agents"], cities: ["San Francisco"], limit: 25 };
    const out = withIntervalOverride(config, 6 * 3600_000);
    expect(out).toEqual({ ...config, intervalMs: 6 * 3600_000 });
    // No mutation of the input — the caller hands over the live query-cache object.
    expect(config).not.toHaveProperty("intervalMs");
  });

  it("removes the override on null (revert to registry default)", () => {
    const out = withIntervalOverride({ topics: ["AI"], intervalMs: 3600_000 }, null);
    expect(out).toEqual({ topics: ["AI"] });
  });

  it("clamps below the backend 60s floor and floors fractional values", () => {
    expect(withIntervalOverride(null, 1000)["intervalMs"]).toBe(MIN_INTERVAL_MS);
    expect(withIntervalOverride(null, 90_000.7)["intervalMs"]).toBe(90_000);
  });

  it("handles a null config", () => {
    expect(withIntervalOverride(null, 3600_000)).toEqual({ intervalMs: 3600_000 });
    expect(withIntervalOverride(null, null)).toEqual({});
  });
});

describe("INTERVAL_PRESETS_MS", () => {
  it("is ascending and entirely above the backend floor", () => {
    for (let i = 0; i < INTERVAL_PRESETS_MS.length; i++) {
      expect(INTERVAL_PRESETS_MS[i]!).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
      if (i > 0) expect(INTERVAL_PRESETS_MS[i]!).toBeGreaterThan(INTERVAL_PRESETS_MS[i - 1]!);
    }
  });
});
