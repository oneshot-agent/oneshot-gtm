import type { AngleOutcomeRow } from "./ledger-drafts.ts";

/**
 * Reply-based content learning: when one of a play's configured angles gets
 * clearly more replies than the play's other angles, on one channel and
 * drafting stage, the founder is offered "lead with it" as a preference
 * (source `outcome`). Style is learned from how the founder writes; what to
 * argue is only suggested when replies back it.
 *
 * An angle qualifies when all of these hold:
 *   - at least `minReached` distinct people were sent it,
 *   - at least `minReplied` of them replied,
 *   - its reply rate is at least `minLift` times the rate of the play's
 *     other angles combined (same channel and stage),
 *   - a one-sided Fisher exact test (`fisherOneSidedGreater`) puts the
 *     chance of a split at least this lopsided, with no real difference,
 *     under `maxP`.
 * Generic defaults: with replies in the low single digits per hundred, an
 * angle needs a real lead before it is suggested at all.
 */
export const OUTCOME_LEARNING_DEFAULTS = {
  minReached: 30,
  minReplied: 3,
  minLift: 2,
  maxP: 0.1,
} as const;

export type OutcomeThresholds = { [K in keyof typeof OUTCOME_LEARNING_DEFAULTS]: number };

export interface QualifiedAngle extends AngleOutcomeRow {
  /** One-sided Fisher exact p-value: this angle replies more than the others. */
  p: number;
}

function logFactorials(n: number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let i = 2; i <= n; i++) out[i] = out[i - 1]! + Math.log(i);
  return out;
}

/**
 * One-sided Fisher exact test on a 2x2 table: `a` of `n1` replied in the
 * first group, `c` of `n2` in the second. Returns P(X >= a), where X is the
 * first group's reply count when the `a + c` replies fall at random across
 * all `n1 + n2` people (hypergeometric). Small means the first group's lead
 * is unlikely to be chance. 1 when either group is empty.
 */
export function fisherOneSidedGreater(a: number, n1: number, c: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 1;
  const total = n1 + n2;
  const replies = a + c;
  const lf = logFactorials(total);
  const logChoose = (n: number, k: number) => lf[n]! - lf[k]! - lf[n - k]!;
  const denominator = logChoose(total, n1);
  let p = 0;
  for (let x = a; x <= Math.min(n1, replies); x++) {
    if (replies - x > n2) continue;
    p += Math.exp(logChoose(replies, x) + logChoose(total - replies, n1 - x) - denominator);
  }
  return Math.min(1, p);
}

/**
 * The configured angles that out-reply their play's other angles by every
 * threshold, best first (smallest p, then the higher reply rate). Integer
 * comparison for the lift, so a 2.0x tie qualifies exactly.
 */
export function qualifyingAngles(
  rows: AngleOutcomeRow[],
  thresholds: OutcomeThresholds = OUTCOME_LEARNING_DEFAULTS,
): QualifiedAngle[] {
  const out: QualifiedAngle[] = [];
  for (const r of rows) {
    if (!r.configured || !r.angleText.trim()) continue;
    if (r.reached < thresholds.minReached || r.replied < thresholds.minReplied) continue;
    if (r.otherReached <= 0) continue;
    // replied/reached >= minLift * otherReplied/otherReached, without division.
    if (r.replied * r.otherReached < thresholds.minLift * r.otherReplied * r.reached) continue;
    const p = fisherOneSidedGreater(r.replied, r.reached, r.otherReplied, r.otherReached);
    if (!(p < thresholds.maxP)) continue;
    out.push({ ...r, p });
  }
  return out.toSorted((x, y) => x.p - y.p || y.replied / y.reached - x.replied / x.reached);
}

/** The angle as a guidance line: one line, no trailing punctuation, at most `max` characters cut at a word. */
export function outcomeAngleText(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut =
    flat.length <= max
      ? flat
      : `${flat
          .slice(0, max)
          .replace(/\s+\S*$/, "")
          .trimEnd()}…`;
  return cut.replace(/[\s.,;:]+$/u, "");
}
