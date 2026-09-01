/**
 * Pure statistics for evaluating the shadow priority score against human
 * review labels (Phase 2 of #410). Lives in packages/find rather than ops/
 * because ops/ is outside the vitest include globs and the score-prospects
 * report reuses the AUC. No I/O, deterministic.
 */

export function meanOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Mann-Whitney AUC: the probability that a random positive outranks a random
 * negative (ties count half). 0.5 = no separation, 1 = perfect, <0.5 =
 * inverted. Midrank tie handling; null when either side is empty — a
 * one-sided comparison is not evidence.
 */
export function mannWhitneyAuc(positives: number[], negatives: number[]): number | null {
  if (positives.length === 0 || negatives.length === 0) return null;
  const all = [
    ...positives.map((v) => ({ v, pos: true })),
    ...negatives.map((v) => ({ v, pos: false })),
  ].toSorted((a, b) => a.v - b.v);
  // Assign midranks: ties share the average of the ranks they span.
  let posRankSum = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const midrank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) {
      if (all[k]!.pos) posRankSum += midrank;
    }
    i = j + 1;
  }
  const nPos = positives.length;
  const nNeg = negatives.length;
  const u = posRankSum - (nPos * (nPos + 1)) / 2;
  return u / (nPos * nNeg);
}

/**
 * Wilson 95% confidence interval for a proportion. Preferred over the normal
 * approximation at the small n this workspace's labels actually have. n = 0
 * returns the uninformative full interval.
 */
export function wilson95(successes: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.959964; // 97.5th percentile of the standard normal
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}
