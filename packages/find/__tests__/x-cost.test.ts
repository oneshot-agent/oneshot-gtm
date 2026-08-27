import { describe, expect, test } from "vitest";
import { CostMeter, SpendExceeded, X_RATES, estimateHarvestCost, money } from "../src/_x-cost.ts";

describe("rates", () => {
  test("twitterapi.io is ~55x cheaper per user than the X API", () => {
    expect(X_RATES.xapi.user / X_RATES.twitterapiio.user).toBeCloseTo(55.6, 0);
  });
});

describe("CostMeter", () => {
  test("prices the run that emptied the X account", () => {
    const m = new CostMeter("xapi", Infinity);
    m.charge({ users: 1124 });
    m.charge({ posts: 270 });
    // 1124 x $0.010 + 270 x $0.005
    expect(m.total).toBeCloseTo(12.59, 2);
  });

  test("the same harvest on twitterapi.io is cents", () => {
    const m = new CostMeter("twitterapiio", Infinity);
    m.charge({ users: 1124 });
    m.charge({ posts: 270 });
    expect(m.total).toBeCloseTo(0.2427, 3);
  });

  test("a request that returns nothing still costs the floor", () => {
    const m = new CostMeter("twitterapiio", Infinity);
    m.charge({});
    expect(m.total).toBeCloseTo(X_RATES.twitterapiio.minRequest, 6);
  });

  test("throws once the ceiling is passed, so the partial harvest survives", () => {
    const m = new CostMeter("xapi", 1.0);
    expect(() => {
      for (let i = 0; i < 20; i++) m.charge({ users: 50 });
    }).toThrow(SpendExceeded);
    expect(m.total).toBeGreaterThan(1.0);
  });

  test("wouldExceed refuses the call before paying for it", () => {
    const m = new CostMeter("xapi", 1.0);
    m.charge({ users: 90 }); // $0.90
    expect(m.wouldExceed(50)).toBe(true);
    expect(m.wouldExceed(5)).toBe(false);
  });

  test("format names the resources, not just the total", () => {
    const m = new CostMeter("twitterapiio", Infinity);
    m.charge({ users: 100, posts: 20 });
    expect(m.format()).toContain("100 users");
    expect(m.format()).toContain("20 posts");
  });
});

describe("estimateHarvestCost", () => {
  test("a six-seed run is under a dollar on twitterapi.io and not on the X API", () => {
    const opts = { seeds: 6, tweetsPerSeed: 5, perTweet: 50 };
    expect(estimateHarvestCost("twitterapiio", opts)).toBeLessThan(1);
    expect(estimateHarvestCost("xapi", opts)).toBeGreaterThan(10);
  });
});

describe("money", () => {
  test("keeps sub-cent amounts legible", () => {
    expect(money(0.0024)).toBe("$0.0024");
    expect(money(12.588)).toBe("$12.59");
  });
});
