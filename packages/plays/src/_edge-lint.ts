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
 * carry a named failure, and free of the vocabulary `_humanizer.md` bans.
 */
import { SLOP_PHRASES } from "./_lib.ts";
import { splitEdgeAngles } from "./_angles.ts";

/** Fewer words than this cannot hold a condition, a failure and a mechanism. */
const MIN_ANGLE_WORDS = 12;
/** A routing clause: the condition the angle fits, which selection matches on. */
const ROUTING_OPENER = /^(?:for|when|if)\b/i;
/** Landing-page verbs — the "could this sit on your site?" test, mechanically. */
const PITCH_SHAPE =
  /\b(?:connects|provides|enables|empowers|streamlines|helps (?:you|founders|teams|companies)|lets you|is an? (?:open[- ]source|all-in-one|unified|complete))\b/i;

export type EdgeWarning =
  | "single-angle"
  | `angle-too-short:${number}`
  | `no-routing-clause:${number}`
  | `reads-as-pitch:${number}`
  | `slop:${string}`;

/** Warnings about an edge. Empty means nothing to say, not that it is good. */
export function lintEdge(edge: string | null | undefined): EdgeWarning[] {
  const angles = splitEdgeAngles(edge);
  if (angles.length === 0) return [];
  const out: EdgeWarning[] = [];
  if (angles.length === 1) out.push("single-angle");
  angles.forEach((angle, i) => {
    const n = i + 1;
    if (angle.split(/\s+/).length < MIN_ANGLE_WORDS) out.push(`angle-too-short:${n}`);
    if (!ROUTING_OPENER.test(angle)) out.push(`no-routing-clause:${n}`);
    if (PITCH_SHAPE.test(angle)) out.push(`reads-as-pitch:${n}`);
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
      return `angle ${n} is too short to carry a failure and a mechanism`;
    case "no-routing-clause":
      return `angle ${n} doesn't open with who it fits ("For a founder selling to clinics —")`;
    case "reads-as-pitch":
      return `angle ${n} reads like a landing page, not something you learned`;
    case "slop":
      return `angle ${n} uses banned copy (${rest.slice(0, -1).join(":")})`;
    default:
      return w;
  }
}
