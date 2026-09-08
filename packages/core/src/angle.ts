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

import { getLedger } from "./ledger.ts";

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
 * True when `source` is traceable to evidence the LLM was actually handed —
 * not merely a non-blank string. A URL-shaped source must appear literally in
 * the rendered evidence text (the GITHUB/DOSSIER/PROFILE PAGE blocks); a
 * named-tier source (`"dossier"`, `"replies:2"`, `"github:live"`) must match
 * one of the tiers `gatherAngleEvidence` actually recorded. Anything else —
 * a hallucinated URL, an invented tier name, "trust me" — is NOT grounded.
 */
function isGroundedSource(source: string, grounding: ProspectAngleGroundingContext): boolean {
  if (URL_SOURCE.test(source)) return grounding.evidenceText.includes(source);
  return grounding.sourceTags.includes(source);
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
    sources: strArray(r["sources"]),
    valueMode,
    buyerStage,
    qualification: str(r["qualification"]) ?? "",
    model: meta.model,
    synthesizedAt: meta.synthesizedAt ?? new Date().toISOString(),
  };
}

/**
 * Fire-and-forget re-synthesis hook (issue #357): a new human reply or a
 * tagged outcome should refresh `angle_json` instead of leaving it frozen at
 * backfill time. The actual work (gatherAngleEvidence + synthesizePersonAngle)
 * lives in `@oneshot-gtm/find`, which depends on this package — core cannot
 * import find back without a cycle, so find registers its implementation
 * here at module load (`packages/find/src/angle.ts`) and core's hot paths
 * (ledger's `recordInboxReply` caller in `pollInboxReplies`, and
 * `tagOutcomeValue` below) call `triggerAngleRefresh` without ever knowing
 * find exists. Until find's module has loaded — e.g. a CLI invocation that
 * never touches `@oneshot-gtm/find` — the trigger is a no-op, the same
 * degrade-gracefully rule every other best-effort call in this codebase
 * follows.
 */
export type AngleRefreshTrigger = (prospectId: number) => void;
let angleRefreshTrigger: AngleRefreshTrigger | null = null;

export function registerAngleRefreshTrigger(fn: AngleRefreshTrigger): void {
  angleRefreshTrigger = fn;
}

/**
 * Debounce window (issue #357's "stale after N hours guard is enough"): a
 * burst of replies on the same live thread, or a reply immediately followed
 * by an outcome tag, must not each re-buy a synthesis. Re-synthesis only
 * fires when the existing `angle_synthesized_at` is missing or older than
 * this, so the guard is entirely a function of the persisted timestamp —
 * no extra state, and correct across process restarts and across the two
 * independent call sites (reply poll, outcome tagging).
 */
export const ANGLE_REFRESH_STALE_HOURS = 6;

/**
 * Best-effort, fire-and-forget: never throws. No-ops until a trigger is
 * registered (find's module hasn't loaded), and no-ops when the angle was
 * synthesized more recently than `ANGLE_REFRESH_STALE_HOURS` ago — the
 * debounce that keeps a reply burst or a reply-then-outcome pair from paying
 * for synthesis twice.
 */
export function triggerAngleRefresh(prospectId: number): void {
  if (!angleRefreshTrigger) return;
  try {
    const prospect = getLedger().getProspectById(prospectId);
    if (!prospect) return;
    if (prospect.angle_synthesized_at) {
      const ageMs = Date.now() - Date.parse(prospect.angle_synthesized_at);
      if (Number.isFinite(ageMs) && ageMs < ANGLE_REFRESH_STALE_HOURS * 3600_000) return;
    }
    angleRefreshTrigger(prospectId);
  } catch {
    // Best-effort — a ledger read failure must never propagate into a
    // caller's hot path (reply recording, outcome tagging).
  }
}

/** Test-only: reset the registered hook between cases. */
export function _resetAngleRefreshTrigger(): void {
  angleRefreshTrigger = null;
}
