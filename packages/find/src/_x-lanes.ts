/**
 * How the per-run slots divide between the two lanes.
 *
 * Ranking across lanes doesn't work: their weights differ, so a founder tops
 * out near 58 where an amplifier reaches 79. Sorting one list buried every
 * founder — and when founders were given priority instead, pure amplifiers
 * stopped appearing at all. Both matter, so each lane gets a reserved share and
 * a short lane spills into the other rather than wasting slots.
 */

import type { XLane, XScoredCandidate } from "./_x-types.ts";

const byScore = (a: XScoredCandidate, b: XScoredCandidate) => b.score - a.score;

export function splitSlots(
  scored: XScoredCandidate[],
  limit: number,
  founderShare: number,
): XScoredCandidate[] {
  const pools: Record<XLane, XScoredCandidate[]> = {
    founder: scored.filter((s) => s.lane === "founder").toSorted(byScore),
    amplifier: scored.filter((s) => s.lane === "amplifier").toSorted(byScore),
  };

  const want: Record<XLane, number> = {
    founder: Math.round(limit * founderShare),
    amplifier: limit - Math.round(limit * founderShare),
  };

  // Whatever one lane can't fill, the other may use.
  for (const [lane, other] of [
    ["founder", "amplifier"],
    ["amplifier", "founder"],
  ] as [XLane, XLane][]) {
    const short = want[lane] - pools[lane].length;
    if (short > 0) {
      want[lane] -= short;
      want[other] += short;
    }
  }

  return [
    ...pools.founder.slice(0, want.founder),
    ...pools.amplifier.slice(0, want.amplifier),
  ].toSorted((a, b) => (a.lane === b.lane ? b.score - a.score : a.lane === "founder" ? -1 : 1));
}
