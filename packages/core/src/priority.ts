import type { ProspectPriority, ProspectPriorityComponents } from "./types.ts";

const COMPONENT_KEYS: Array<keyof ProspectPriorityComponents> = [
  "personFit",
  "accountFit",
  "intentStrength",
  "timingFreshness",
  "signalConfidence",
  "contactability",
];

/** A score under the contract: a finite integer in 0..100. */
function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

/**
 * Parse and shape-check a persisted `priority_json` artifact. The single
 * authority on what counts as a valid stored score — the API projection, the
 * backfill's resume-skip, and the shadow report all use it, so a partial or
 * corrupted artifact that the API would hide as `priority: null` is also seen
 * as "not scored" by the backfill and gets repaired on the next run.
 *
 * Strict on the numbers (integers 0..100 only — a `total: -1` or
 * `personFit: 999` is corruption, not data), normalizing on the trimmings
 * (non-string reasons dropped, missing scoredAt reads as "").
 */
export function parseProspectPriority(raw: string | null | undefined): ProspectPriority | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p["version"] !== "heuristic-v1") return null;
  if (!isScore(p["total"])) return null;
  const rawComponents = p["components"];
  if (rawComponents === null || typeof rawComponents !== "object" || Array.isArray(rawComponents)) {
    return null;
  }
  const c = rawComponents as Record<string, unknown>;
  if (COMPONENT_KEYS.some((k) => !isScore(c[k]))) return null;
  if (!Array.isArray(p["reasons"]) || typeof p["finder"] !== "string") return null;
  return {
    version: "heuristic-v1",
    total: p["total"],
    components: {
      personFit: c["personFit"] as number,
      accountFit: c["accountFit"] as number,
      intentStrength: c["intentStrength"] as number,
      timingFreshness: c["timingFreshness"] as number,
      signalConfidence: c["signalConfidence"] as number,
      contactability: c["contactability"] as number,
    },
    reasons: p["reasons"].filter((r): r is string => typeof r === "string"),
    finder: p["finder"],
    scoredAt: typeof p["scoredAt"] === "string" ? p["scoredAt"] : "",
  };
}
