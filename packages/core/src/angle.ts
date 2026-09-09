/**
 * `prospects.angle_json` — the per-prospect synthesis this file's callers
 * (packages/plays/src/angle.ts, apps/cli synthesize-angles) produce and
 * persist via `Ledger.setProspectAngle` (issue #355).
 *
 * `relationship` answers WHAT they build (their own account of it);
 * `valueMode`/`buyerStage` answer HOW to treat them (could they buy, at what
 * stage) — kept as separate fields per the 2026-09-01 refinement so a warm,
 * technical reply from a student-led lab is never inflated into a buyer
 * signal just because the tone was friendly.
 */

export type AngleRelationship =
  | "builder"
  | "adjacent"
  | "competitor"
  | "user"
  | "researcher"
  | "unknown";

export type AngleValueMode =
  | "customer"
  | "user"
  | "design-partner"
  | "advocate"
  | "collaborator"
  | "unknown";

export type AngleBuyerStage =
  | "at-scale"
  | "funded-company"
  | "pre-scale"
  | "student-or-hobby"
  | "unknown";

export interface ProspectAngleEvidence {
  claim: string;
  /** A real citation — a URL, or a named source like "dossier" / "replies:2". */
  source: string;
}

/**
 * What `parseProspectAngle` checks each `evidence[].source` against so a
 * citation must be traceable to evidence the LLM was actually handed, not
 * merely non-blank.
 */
export interface ProspectAngleGroundingContext {
  /** The exact evidence text rendered into the synthesis prompt — a URL
   *  citation is grounded only when it appears literally in here (the URLs
   *  that show up in the GITHUB/DOSSIER/PROFILE PAGE blocks). */
  evidenceText: string;
  /** The evidence tiers actually gathered for this prospect, e.g.
   *  `["dossier", "github:live", "replies:3"]` — a named citation like
   *  "dossier" or "replies:2" is grounded only when the matching tier is
   *  in here, i.e. it was really gathered rather than invented. */
  sourceTags: string[];
}

export interface ProspectAngle {
  /** 3-4 paragraph prose: who they are / what they build / why they fit. */
  brief: string;
  /** One-line, current, specific opener the next message leads with. */
  hook: string;
  relationship: AngleRelationship;
  evidence: ProspectAngleEvidence[];
  /** Premises they've already corrected in a reply — never repeat these. */
  doNotSay: string[];
  /** The single most natural next move. */
  nextStep: string;
  /** Which evidence tiers fed this synthesis, e.g. ["dossier", "github:live", "replies:3"]. */
  sources: string[];
  valueMode: AngleValueMode;
  buyerStage: AngleBuyerStage;
  /** One line: why this valueMode/stage, citing the signal. */
  qualification: string;
  model: string;
  synthesizedAt: string;
}

const RELATIONSHIPS: ReadonlySet<string> = new Set<AngleRelationship>([
  "builder",
  "adjacent",
  "competitor",
  "user",
  "researcher",
  "unknown",
]);

const VALUE_MODES: ReadonlySet<string> = new Set<AngleValueMode>([
  "customer",
  "user",
  "design-partner",
  "advocate",
  "collaborator",
  "unknown",
]);

const BUYER_STAGES: ReadonlySet<string> = new Set<AngleBuyerStage>([
  "at-scale",
  "funded-company",
  "pre-scale",
  "student-or-hobby",
  "unknown",
]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => x.trim());
}

const URL_SOURCE: RegExp = /^https?:\/\//i;

/**
 * Named-tier source aliases: a citation using the LEFT name is accepted when
 * either it or its RIGHT alias is in `sourceTags`. Needed because the DOSSIER
 * evidence block renders identically whether the dossier was already stored
 * (`sources` tag `"dossier"`) or freshly bought this run (tag
 * `"dossier:live"` — see `gatherAngleEvidence`), and the synthesis prompt's
 * own literal example tells the model to cite it as `"dossier"` either way
 * (packages/prompts/angle-synthesis.md:36). Without this, a legitimate
 * `"dossier"` citation on a paid-research prospect was silently dropped by
 * `isGroundedSource` even though the evidence really was gathered (issue
 * #569 freshness audit).
 */
const NAMED_SOURCE_ALIASES: ReadonlyMap<string, string> = new Map([["dossier", "dossier:live"]]);

/**
 * True when `source` is traceable to evidence the LLM was actually handed —
 * not merely a non-blank string. A URL-shaped source must appear literally in
 * the rendered evidence text (the GITHUB/DOSSIER/PROFILE PAGE blocks); a
 * named-tier source (`"dossier"`, `"replies:2"`, `"github:live"`) must match
 * one of the tiers `gatherAngleEvidence` actually recorded, or that tier's
 * alias (see `NAMED_SOURCE_ALIASES`). Anything else — a hallucinated URL, an
 * invented tier name, "trust me" — is NOT grounded.
 */
function isGroundedSource(source: string, grounding: ProspectAngleGroundingContext): boolean {
  if (URL_SOURCE.test(source)) return grounding.evidenceText.includes(source);
  if (grounding.sourceTags.includes(source)) return true;
  const alias = NAMED_SOURCE_ALIASES.get(source);
  return alias !== undefined && grounding.sourceTags.includes(alias);
}

/**
 * Validate + sanitize the LLM's raw angle JSON into a `ProspectAngle`, or
 * null when there is nothing worth storing.
 *
 * Every `evidence` entry without a claim, a non-blank source, AND a source
 * that actually traces to `grounding` (a URL literally present in the
 * rendered evidence, or a source tier that was really gathered) is DROPPED,
 * never kept on the strength of a non-empty string alone — an uncited or
 * fabricated claim in a "grounded" artifact is worse than no claim, because
 * it reads as sourced when it isn't. This is the anti-fabrication gate issue
 * #355 exists to enforce.
 *
 * `relationship` / `valueMode` / `buyerStage` outside the known enum collapse
 * to `"unknown"` rather than rejecting the whole synthesis — a slightly-off
 * enum value from the model shouldn't throw away a usable `brief`/`hook`.
 *
 * Returns null only when BOTH `brief` and `hook` are missing/empty: at that
 * point nothing was actually synthesized, and persisting an all-null shell
 * would look like a completed row to `listProspectsForAngle`'s resume logic.
 */
export function parseProspectAngle(
  raw: unknown,
  meta: { model: string; synthesizedAt?: string },
  grounding: ProspectAngleGroundingContext,
): ProspectAngle | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const brief = str(r["brief"]);
  const hook = str(r["hook"]);
  if (!brief && !hook) return null;

  const rawEvidence = Array.isArray(r["evidence"]) ? (r["evidence"] as unknown[]) : [];
  const evidence: ProspectAngleEvidence[] = rawEvidence
    .map((e) => {
      if (e === null || typeof e !== "object") return null;
      const claim = str((e as Record<string, unknown>)["claim"]);
      const source = str((e as Record<string, unknown>)["source"]);
      if (!claim || !source) return null;
      if (!isGroundedSource(source, grounding)) return null;
      return { claim, source };
    })
    .filter((e): e is ProspectAngleEvidence => e !== null);

  const relationshipRaw = r["relationship"];
  const relationship: AngleRelationship =
    typeof relationshipRaw === "string" && RELATIONSHIPS.has(relationshipRaw)
      ? (relationshipRaw as AngleRelationship)
      : "unknown";

  const valueModeRaw = r["valueMode"];
  const valueMode: AngleValueMode =
    typeof valueModeRaw === "string" && VALUE_MODES.has(valueModeRaw)
      ? (valueModeRaw as AngleValueMode)
      : "unknown";

  const buyerStageRaw = r["buyerStage"];
  const buyerStage: AngleBuyerStage =
    typeof buyerStageRaw === "string" && BUYER_STAGES.has(buyerStageRaw)
      ? (buyerStageRaw as AngleBuyerStage)
      : "unknown";

  return {
    brief: brief ?? "",
    hook: hook ?? "",
    relationship,
    evidence,
    doNotSay: strArray(r["doNotSay"]),
    nextStep: str(r["nextStep"]) ?? "",
    sources: strArray(r["sources"]).filter((s) => isGroundedSource(s, grounding)),
    valueMode,
    buyerStage,
    qualification: str(r["qualification"]) ?? "",
    model: meta.model,
    synthesizedAt: meta.synthesizedAt ?? new Date().toISOString(),
  };
}

/**
 * Render a persisted `prospects.angle_json` value into an ANGLE input block
 * for a draft prompt — issue #356, the payoff for #355's synthesis. `hook`
 * is what the next message should lead with; `doNotSay` is what stops a
 * draft re-asserting a premise the prospect already corrected — the
 * strongest signal of the two, since repeating it reads as not having read
 * their reply. `evidence`/`nextStep` are included when present because they
 * cost nothing extra and a concrete citation beats a vague hook.
 *
 * Guarded and additive by design: missing, blank, unparsable, or
 * all-empty-fields JSON returns null so callers can skip the block
 * entirely — a prospect with no synthesis yet must see byte-identical
 * output to before this issue.
 */
export function angleBlockFromJson(
  raw: string | null | undefined,
  opts: { maxEvidence?: number } = {},
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const a = parsed as Record<string, unknown>;

  const hook = str(a["hook"]);
  const doNotSay = strArray(a["doNotSay"]);
  const nextStep = str(a["nextStep"]);
  const rawEvidence = Array.isArray(a["evidence"]) ? (a["evidence"] as unknown[]) : [];
  const evidence = rawEvidence
    .map((e) => {
      if (e === null || typeof e !== "object") return null;
      const claim = str((e as Record<string, unknown>)["claim"]);
      const source = str((e as Record<string, unknown>)["source"]);
      return claim && source ? { claim, source } : null;
    })
    .filter((e): e is ProspectAngleEvidence => e !== null);

  if (!hook && doNotSay.length === 0 && !nextStep && evidence.length === 0) return null;

  const maxEvidence = opts.maxEvidence ?? 3;
  const lines: string[] = [
    "ANGLE (synthesized read on this prospect — a hook to lead with, and premises never to repeat):",
  ];
  if (hook) lines.push(`Hook: ${hook}`);
  if (doNotSay.length > 0) {
    lines.push("Do NOT say (they already corrected these in a reply — never repeat):");
    for (const d of doNotSay) lines.push(`- ${d}`);
  }
  if (evidence.length > 0) {
    lines.push("Evidence:");
    for (const e of evidence.slice(0, maxEvidence)) lines.push(`- ${e.claim} (${e.source})`);
  }
  if (nextStep) lines.push(`Next step: ${nextStep}`);
  return lines.join("\n");
}
