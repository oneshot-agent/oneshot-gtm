import { describe, expect, it } from "vitest";
import { mannWhitneyAuc, meanOf, wilson95 } from "../src/_gauge.ts";

describe("mannWhitneyAuc", () => {
  it("is 1 for perfect separation and 0 when inverted", () => {
    expect(mannWhitneyAuc([70, 80, 90], [10, 20, 30])).toBe(1);
    expect(mannWhitneyAuc([10, 20, 30], [70, 80, 90])).toBe(0);
  });

  it("is 0.5 for identical distributions (all ties, midranked)", () => {
    expect(mannWhitneyAuc([50, 50, 50], [50, 50])).toBe(0.5);
  });

  it("handles partial ties by midrank", () => {
    // positives [1, 2], negatives [2, 3]: pairs → (1<2)=0, (1<3)=0, (2=2)=0.5, (2<3)=0 → 0.5/4
    expect(mannWhitneyAuc([1, 2], [2, 3])).toBeCloseTo(0.125);
  });

  it("matches the pairwise definition on an unsorted mixed sample", () => {
    const pos = [61, 55, 72];
    const neg = [58, 61, 40, 66];
    let wins = 0;
    for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
    expect(mannWhitneyAuc(pos, neg)).toBeCloseTo(wins / (pos.length * neg.length));
  });

  it("returns null when either side is empty — one-sided data is not evidence", () => {
    expect(mannWhitneyAuc([], [1, 2])).toBeNull();
    expect(mannWhitneyAuc([1, 2], [])).toBeNull();
  });
});

describe("wilson95", () => {
  it("is symmetric around 0.5 at p=0.5", () => {
    const { lo, hi } = wilson95(50, 100);
    expect(lo + hi).toBeCloseTo(1, 5);
    expect(lo).toBeGreaterThan(0.39);
    expect(hi).toBeLessThan(0.61);
  });

  it("stays within [0,1] at the extremes and widens at small n", () => {
    const zero = wilson95(0, 5);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0.3); // 0/5 is still compatible with a real rate
    const full = wilson95(5, 5);
    expect(full.hi).toBe(1);
    expect(full.lo).toBeLessThan(0.7);
  });

  it("returns the uninformative interval for n=0", () => {
    expect(wilson95(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("meanOf", () => {
  it("averages, and refuses an empty sample", () => {
    expect(meanOf([1, 2, 3])).toBe(2);
    expect(meanOf([])).toBeNull();
  });
});
