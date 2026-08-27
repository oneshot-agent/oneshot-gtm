import type { DoctorCheck } from "@oneshot-gtm/shared-types";

export type DoctorTone = "receipt" | "spend" | "blocked";

export interface DoctorSummary {
  failing: number;
  warnings: number;
  /** "all clear" · "2 warnings" · "1 failing · 2 warnings" */
  text: string;
  tone: DoctorTone;
}

/**
 * Roll a doctor payload up to one line. Shared by the DoctorPanel header and
 * the Today page's health card so the two can never disagree about what
 * "healthy" means.
 */
export function summarizeDoctor(checks: DoctorCheck[] | undefined): DoctorSummary {
  const failing = checks?.filter((c) => c.severity === "fail").length ?? 0;
  const warnings = checks?.filter((c) => c.severity === "warn").length ?? 0;
  if (failing > 0) {
    return {
      failing,
      warnings,
      text: `${failing} failing · ${warnings} warning${warnings === 1 ? "" : "s"}`,
      tone: "blocked",
    };
  }
  if (warnings > 0) {
    return {
      failing,
      warnings,
      text: `${warnings} warning${warnings === 1 ? "" : "s"}`,
      tone: "spend",
    };
  }
  return { failing: 0, warnings: 0, text: "all clear", tone: "receipt" };
}

/** Worst severity wins the accent: fail > warn > ok. */
export function worstOf(checks: DoctorCheck[]): DoctorCheck["severity"] {
  if (checks.some((c) => c.severity === "fail")) return "fail";
  if (checks.some((c) => c.severity === "warn")) return "warn";
  return "ok";
}
