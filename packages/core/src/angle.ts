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

/**
 * Validate + sanitize the LLM's raw angle JSON into a `ProspectAngle`, or
 * null when there is nothing worth storing.
 *
 * Every `evidence` entry without BOTH a claim and a real source is DROPPED,
 * never kept with a blank source — an uncited claim in a "grounded" artifact
 * is worse than no claim, because it reads as sourced when it isn't. This is
 * the anti-fabrication gate issue #355 exists to enforce.
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
    sources: strArray(r["sources"]),
    valueMode,
    buyerStage,
    qualification: str(r["qualification"]) ?? "",
    model: meta.model,
    synthesizedAt: meta.synthesizedAt ?? new Date().toISOString(),
  };
}
