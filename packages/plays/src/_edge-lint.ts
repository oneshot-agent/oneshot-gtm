/**
 * Warn-tier lint for a `yourEdge` / `yourClaim` string (issue #585).
 *
 * The edge is the only founder-authored input the Offer beat is built from,
 * and until this nothing looked at it: every readiness gate is
 * `trim().length > 0`, `lintEmail` runs only on drafted mail, and the
 * strategist writes edges into config with no definition of a good one. So
 * feature lists and single flat pitches went in, and the drafts inherited
 * them.
 *
 * This is guidance, not a gate: it returns warnings for the UI to show and
 * never blocks a save — `yourEdge: "x"` is a fixture throughout the test
 * suite, and a founder mid-edit should not be refused. Selection (#584)
 * happens in code, so the checks are about what a selectable, non-pitch angle
 * looks like: several of them, each opening with who it fits, long enough to
 * carry a lesson (a named failure and what was learned) or an opportunity
 * resting on one concrete fact, and free of the vocabulary `_humanizer.md`
 * bans. An opportunity that promises an outcome with nothing behind it — no
 * number, nothing the product description names — is flagged as unbacked.
 */
import { SLOP_PHRASES } from "./_lib.ts";
import { splitEdgeAngles } from "./_angles.ts";

/** Fewer words than this cannot hold a condition plus a lesson or a concrete fact. */
const MIN_ANGLE_WORDS = 12;
/** A routing clause: the condition the angle fits, which selection matches on. */
const ROUTING_OPENER = /^(?:for|when|if)\b/i;
/** Landing-page verbs — the "could this sit on your site?" test, mechanically. */
const PITCH_SHAPE =
  /\b(?:connects|provides|enables|empowers|streamlines|helps (?:you|founders|teams|companies)|lets you|is an? (?:open[- ]source|all-in-one|unified|complete))\b/i;

/**
 * Outcome language — what an opportunity angle promises. Only an angle that
 * uses it is checked for a backing fact; a lesson angle rarely does.
 */
const OUTCOME_CLAIM =
  /\b(?:edge|advantage|ahead of|set(?:s|ting)? the bar|opportunity|outpace|leapfrog|(?:grow|move|ship|win)s? faster|faster than|before (?:their|your) (?:peers|competitors|rivals))\b/i;
const STOPWORDS = new Set(
  "about after again against their there these those which while would could should other every where being having into from with your that this what when than then them they have will more most some such only also just over under very make made".split(
    " ",
  ),
);

export type EdgeWarning =
  | "single-angle"
  | `angle-too-short:${number}`
  | `no-routing-clause:${number}`
  | `reads-as-pitch:${number}`
  | `unbacked-claim:${number}`
  | `slop:${string}`;

export interface EdgeLintContext {
  /**
   * Words that count as a concrete fact when an angle promises an outcome:
   * the product's own description (see `factTermsFrom`). Absent = the
   * unbacked-claim check only accepts a number.
   */
  factTerms?: ReadonlySet<string>;
}

/** Content words (≥5 letters, not stopwords) from the product's own description. */
export function factTermsFrom(...texts: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of (t ?? "").toLowerCase().match(/\p{L}[\p{L}\p{N}-]{4,}/gu) ?? []) {
      if (!STOPWORDS.has(w)) out.add(w);
    }
  }
  return out;
}

function isUnbacked(angle: string, ctx: EdgeLintContext): boolean {
  if (!OUTCOME_CLAIM.test(angle)) return false;
  if (/\d/.test(angle)) return false;
  const words = angle.toLowerCase().match(/\p{L}[\p{L}\p{N}-]{4,}/gu) ?? [];
  return !words.some((w) => ctx.factTerms?.has(w) && !OUTCOME_CLAIM.test(w));
}

/** Warnings about an edge. Empty means nothing to say, not that it is good. */
export function lintEdge(
  edge: string | null | undefined,
  ctx: EdgeLintContext = {},
): EdgeWarning[] {
  const angles = splitEdgeAngles(edge);
  if (angles.length === 0) return [];
  const out: EdgeWarning[] = [];
  if (angles.length === 1) out.push("single-angle");
  angles.forEach((angle, i) => {
    const n = i + 1;
    if (angle.split(/\s+/).length < MIN_ANGLE_WORDS) out.push(`angle-too-short:${n}`);
    if (!ROUTING_OPENER.test(angle)) out.push(`no-routing-clause:${n}`);
    if (PITCH_SHAPE.test(angle)) out.push(`reads-as-pitch:${n}`);
    if (isUnbacked(angle, ctx)) out.push(`unbacked-claim:${n}`);
    for (const [re, label] of SLOP_PHRASES) {
      if (re.test(angle)) out.push(`slop:${label}:${n}`);
    }
  });
  return out;
}

/** One founder-facing sentence per warning, for a toast or an inline note. */
export function describeEdgeWarning(w: EdgeWarning): string {
  if (w === "single-angle") {
    return "one angle only — give the tool several (`//`-separated) so each prospect gets the one that fits";
  }
  const [kind, ...rest] = w.split(":");
  const n = rest.at(-1);
  switch (kind) {
    case "angle-too-short":
      return `angle ${n} is too short to carry a lesson or one concrete fact`;
    case "no-routing-clause":
      return `angle ${n} doesn't open with who it fits ("For a founder selling to clinics —")`;
    case "reads-as-pitch":
      return `angle ${n} reads like a landing page — name what you learned, or the concrete fact behind the opportunity`;
    case "unbacked-claim":
      return `angle ${n} promises an outcome without a fact behind it — add the number or the capability that makes it true`;
    case "slop":
      return `angle ${n} uses banned copy (${rest.slice(0, -1).join(":")})`;
    default:
      return w;
  }
}
