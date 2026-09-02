import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.ts";

/**
 * The fitted priority-calibration artifact (Phase 3 of #410) — written by
 * `find calibrate --fit`, read for SHADOW DISPLAY only. Nothing orders,
 * gates, drains, or sends by it; the future adoption gate
 * (`queuePriorityCalibration?: "off" | "shadow"`) is deliberately NOT a
 * config field yet — it would be dead config until adoption is
 * evidence-gated in a later phase.
 *
 * Lives as a configDir JSON file (not a ledger table): it is per-workspace
 * configuration the scoring engine must be able to read without a ledger
 * dependency, and the file is trivially inspectable and deletable. Resolver
 * shape follows ops/_titles.ts: env override, then configDir; a MISSING file
 * is null (not calibrated), an EXISTING-but-unusable file throws — silence
 * there would misreport "not calibrated" over a real artifact.
 */

const COMPONENT_KEYS = [
  "personFit",
  "accountFit",
  "intentStrength",
  "timingFreshness",
  "signalConfidence",
  "contactability",
] as const;

export interface FinderCalibration {
  /** Keyed, not positional — order drift between packages cannot corrupt it. */
  weights: Record<(typeof COMPONENT_KEYS)[number], number>;
  bias: number;
  nPos: number;
  nNeg: number;
  holdoutAuc: number | null;
}

export interface ProspectCalibration {
  version: "logistic-v1";
  fittedAt: string;
  /** The label target, named so a future meeting-level fit can't be misread. */
  outcome: "reply";
  /** Records the OUTCOME_MATURITY_DAYS the labels were built with. */
  maturityDays: number;
  perFinder: Record<string, FinderCalibration>;
}

export function calibrationPath(): string {
  return process.env["ONESHOT_GTM_CALIBRATION"] ?? join(configDir(), "priority-calibration.json");
}

/** Strict on numbers, normalizing on trimmings — parseProspectPriority style. */
export function parseProspectCalibration(raw: string): ProspectCalibration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p["version"] !== "logistic-v1") return null;
  if (p["outcome"] !== "reply") return null;
  if (typeof p["maturityDays"] !== "number" || !Number.isFinite(p["maturityDays"])) return null;
  const rawPerFinder = p["perFinder"];
  if (rawPerFinder === null || typeof rawPerFinder !== "object" || Array.isArray(rawPerFinder)) {
    return null;
  }
  const perFinder: Record<string, FinderCalibration> = {};
  for (const [finder, value] of Object.entries(rawPerFinder as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    const weights = v["weights"];
    if (weights === null || typeof weights !== "object" || Array.isArray(weights)) return null;
    const w = weights as Record<string, unknown>;
    if (COMPONENT_KEYS.some((k) => typeof w[k] !== "number" || !Number.isFinite(w[k] as number))) {
      return null;
    }
    if (typeof v["bias"] !== "number" || !Number.isFinite(v["bias"])) return null;
    if (typeof v["nPos"] !== "number" || typeof v["nNeg"] !== "number") return null;
    perFinder[finder] = {
      weights: Object.fromEntries(
        COMPONENT_KEYS.map((k) => [k, w[k] as number]),
      ) as FinderCalibration["weights"],
      bias: v["bias"],
      nPos: v["nPos"],
      nNeg: v["nNeg"],
      holdoutAuc: typeof v["holdoutAuc"] === "number" ? v["holdoutAuc"] : null,
    };
  }
  return {
    version: "logistic-v1",
    fittedAt: typeof p["fittedAt"] === "string" ? p["fittedAt"] : "",
    outcome: "reply",
    maturityDays: p["maturityDays"],
    perFinder,
  };
}

/** Absent → null (not calibrated). Present-but-unusable → throws. */
export function readProspectCalibration(): ProspectCalibration | null {
  const path = calibrationPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = parseProspectCalibration(raw);
  if (parsed === null) {
    throw new Error(
      `priority calibration at ${path} exists but is unusable — fix or delete it ` +
        `(a silent null here would misreport "not calibrated" over a real artifact)`,
    );
  }
  return parsed;
}
