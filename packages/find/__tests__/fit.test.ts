import { describe, expect, it } from "vitest";
import { calibrationBuckets, fitLogistic, holdoutSplit, predictLogistic } from "../src/_fit.ts";
import { mannWhitneyAuc } from "../src/_gauge.ts";

/** Deterministic synthetic data — no RNG anywhere in these tests. */
function separable(n: number): { xs: number[][]; ys: Array<0 | 1> } {
  const xs: number[][] = [];
  const ys: Array<0 | 1> = [];
  for (let i = 0; i < n; i++) {
    const positive = i % 2 === 0;
    // Positives live high on feature 0, negatives low; feature 1 is noise-ish.
    xs.push([positive ? 0.8 + (i % 5) * 0.02 : 0.2 + (i % 5) * 0.02, (i % 7) / 10]);
    ys.push(positive ? 1 : 0);
  }
  return { xs, ys };
}

describe("fitLogistic", () => {
  it("separable data → near-perfect ranking, and refits are bit-identical", () => {
    const { xs, ys } = separable(80);
    const fit = fitLogistic(xs, ys);
    const pos = xs.filter((_, i) => ys[i] === 1).map((x) => predictLogistic(fit, x));
    const neg = xs.filter((_, i) => ys[i] === 0).map((x) => predictLogistic(fit, x));
    expect(mannWhitneyAuc(pos, neg)).toBe(1);
    expect(fitLogistic(xs, ys)).toEqual(fit); // determinism, bit for bit
  });

  it("label-shuffled data → no separation (~0.5)", () => {
    const { xs } = separable(80);
    // Labels alternate independent of the features' informative dimension.
    const ys = xs.map((_, i): 0 | 1 => (i % 4 < 2 ? 1 : 0));
    const fit = fitLogistic(xs, ys);
    const pos = xs.filter((_, i) => ys[i] === 1).map((x) => predictLogistic(fit, x));
    const neg = xs.filter((_, i) => ys[i] === 0).map((x) => predictLogistic(fit, x));
    const auc = mannWhitneyAuc(pos, neg)!;
    expect(auc).toBeGreaterThan(0.35);
    expect(auc).toBeLessThan(0.65);
  });

  it("stronger L2 shrinks the weights", () => {
    const { xs, ys } = separable(80);
    const loose = fitLogistic(xs, ys, { lambda: 0.01 });
    const tight = fitLogistic(xs, ys, { lambda: 10 });
    expect(Math.abs(tight.weights[0]!)).toBeLessThan(Math.abs(loose.weights[0]!));
  });

  it("rejects empty and mismatched inputs", () => {
    expect(() => fitLogistic([], [])).toThrow();
    expect(() => fitLogistic([[1]], [1, 0])).toThrow();
  });
});

describe("holdoutSplit", () => {
  it("is deterministic, disjoint-and-complete, and roughly 20%", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ key: `dedupe-${i}` }));
    const a = holdoutSplit(rows, (r) => r.key);
    const b = holdoutSplit(rows, (r) => r.key);
    expect(b).toEqual(a);
    expect(a.train.length + a.holdout.length).toBe(500);
    expect(a.holdout.length).toBeGreaterThan(60);
    expect(a.holdout.length).toBeLessThan(140);
  });
});

describe("calibrationBuckets", () => {
  it("bins by predicted probability and reports observed rates", () => {
    const pairs = Array.from({ length: 100 }, (_, i) => ({
      p: i / 100,
      // Observed tracks predicted: y=1 for the top half.
      y: (i >= 50 ? 1 : 0) as 0 | 1,
    }));
    const buckets = calibrationBuckets(pairs, 5);
    expect(buckets).toHaveLength(5);
    expect(buckets[0]!.observedRate).toBe(0);
    expect(buckets[4]!.observedRate).toBe(1);
    expect(buckets.reduce((a, b) => a + b.n, 0)).toBe(100);
    expect(calibrationBuckets([])).toEqual([]);
  });
});
