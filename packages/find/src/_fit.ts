import { stableHash } from "./_rank.ts";

/**
 * Pure, dependency-free logistic regression for priority calibration
 * (Phase 3 of #410). Deterministic by construction — zero-init, full-batch
 * gradient descent, fixed iteration count, no RNG — so a refit on identical
 * labels is bit-identical.
 *
 * Features are the 6 component scores / 100, deliberately NOT standardized:
 * they already share one constructed 0–100 scale, so standardization buys
 * nothing statistically but would cost artifact simplicity (means/sds to
 * persist and version) and destroy direct comparability of fitted weights
 * against the hand-set heuristic weights — which is the whole point of the
 * shadow display. At ~30 positives and 7 parameters, the fixed L2 penalty is
 * what makes the fit defensible at all; the holdout AUC display is the
 * honesty mechanism.
 */

export interface LogisticFit {
  weights: number[];
  bias: number;
}

export interface FitOptions {
  /** L2 strength (bias unpenalized). */
  lambda?: number;
  iterations?: number;
  learningRate?: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function fitLogistic(xs: number[][], ys: Array<0 | 1>, opts: FitOptions = {}): LogisticFit {
  const lambda = opts.lambda ?? 1.0;
  const iterations = opts.iterations ?? 500;
  const learningRate = opts.learningRate ?? 0.5;
  const n = xs.length;
  if (n === 0 || n !== ys.length) throw new Error("fitLogistic: empty or mismatched inputs");
  const d = xs[0]!.length;
  const weights = Array.from({ length: d }, () => 0);
  let bias = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const gradW = Array.from({ length: d }, () => 0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j]! * x[j]!;
      const err = sigmoid(z) - ys[i]!;
      for (let j = 0; j < d; j++) gradW[j]! += err * x[j]!;
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      weights[j]! -= learningRate * (gradW[j]! / n + (lambda / n) * weights[j]!);
    }
    bias -= learningRate * (gradB / n);
  }
  return { weights, bias };
}

export function predictLogistic(fit: LogisticFit, x: number[]): number {
  let z = fit.bias;
  for (let j = 0; j < x.length; j++) z += fit.weights[j]! * x[j]!;
  return sigmoid(z);
}

/**
 * Deterministic ~20% holdout: the same stable hash that drives the ranked
 * view's exploration rotation, keyed per row — stable across refits and
 * uncorrelated with time or score.
 */
export function holdoutSplit<T>(rows: T[], keyOf: (r: T) => string): { train: T[]; holdout: T[] } {
  const train: T[] = [];
  const holdout: T[] = [];
  for (const row of rows) {
    (stableHash(keyOf(row)) % 5 === 0 ? holdout : train).push(row);
  }
  return { train, holdout };
}

/**
 * Calibration curve buckets: k equal-count bins by predicted probability,
 * each reporting mean prediction vs observed rate. A calibrated model's two
 * columns track each other.
 */
export function calibrationBuckets(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  k = 5,
): Array<{ meanPredicted: number; observedRate: number; n: number }> {
  if (pairs.length === 0) return [];
  const sorted = [...pairs].toSorted((a, b) => a.p - b.p);
  const out: Array<{ meanPredicted: number; observedRate: number; n: number }> = [];
  const per = Math.ceil(sorted.length / k);
  for (let i = 0; i < sorted.length; i += per) {
    const bin = sorted.slice(i, i + per);
    out.push({
      meanPredicted: bin.reduce((a, b) => a + b.p, 0) / bin.length,
      observedRate: bin.reduce((a, b) => a + b.y, 0) / bin.length,
      n: bin.length,
    });
  }
  return out;
}
