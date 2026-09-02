import { writeFileSync } from "node:fs";
import {
  calibrationPath,
  getLedger,
  parseProspectCalibration,
  type FinderCalibration,
  type ProspectCalibration,
  readProspectCalibration,
} from "@oneshot-gtm/core";
import { PRIORITY_COMPONENT_KEYS } from "@oneshot-gtm/shared-types";
import {
  OUTCOME_MATURITY_DAYS,
  type SentOutcomeLabel,
  calibrationBuckets,
  fitLogistic,
  holdoutSplit,
  mannWhitneyAuc,
  predictLogistic,
} from "@oneshot-gtm/find";
import { assembleOutcomeLabels } from "./score-prospects.ts";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * Threshold-gated priority calibration (Phase 3 of #410). The default run is
 * a READINESS TABLE in the soft-gate tradition of `handoff readiness`: per
 * finder, how many real outcome labels exist vs the fitting floors, verdict
 * "not yet" until the data earns the fit. `--fit` fits ONLY finders past
 * every floor and writes the versioned artifact for shadow display.
 *
 * Deliberately absent, as decisions not omissions:
 * - no `--force`: fitting below threshold produces noise dressed as a model;
 * - no approvals-fallback: fitting on human approve/reject labels was
 *   explicitly deferred — this command trains on OUTCOMES (human replies,
 *   meetings, deals) only, and automatic rejections are structurally
 *   excluded upstream (they are never outcome rows at all).
 *
 * These are fitting floors, not adoption bars — adoption stays evidence-
 * gated later (future config field: queuePriorityCalibration "off"|"shadow").
 */
export const CALIBRATION_THRESHOLDS = {
  /** Below ~30 positives the holdout AUC is noise (gauge's measured floor). */
  minPositives: 30,
  /** Keeps the negative class from being a handful of early sends. */
  minNegatives: 50,
  /** Makes the two floors jointly reachable and leaves a real holdout. */
  minMature: 150,
} as const;

export interface FinderReadiness {
  finder: string;
  positives: number;
  negatives: number;
  mature: number;
  /** Mature rows that also carry a current score (the fit's actual input). */
  scoredMature: number;
  ready: boolean;
}

export function assessReadiness(labels: SentOutcomeLabel[]): FinderReadiness[] {
  const byFinder = new Map<string, SentOutcomeLabel[]>();
  for (const label of labels) {
    byFinder.set(label.finder, [...(byFinder.get(label.finder) ?? []), label]);
  }
  return [...byFinder.entries()]
    .map(([finder, rows]): FinderReadiness => {
      const positives = rows.filter((r) => r.label === "positive").length;
      const negatives = rows.filter((r) => r.label === "negative").length;
      const mature = positives + negatives;
      const scoredMature = rows.filter(
        (r) => (r.label === "positive" || r.label === "negative") && r.components !== null,
      ).length;
      return {
        finder,
        positives,
        negatives,
        mature,
        scoredMature,
        ready:
          positives >= CALIBRATION_THRESHOLDS.minPositives &&
          negatives >= CALIBRATION_THRESHOLDS.minNegatives &&
          mature >= CALIBRATION_THRESHOLDS.minMature,
      };
    })
    .toSorted((a, b) => a.finder.localeCompare(b.finder));
}

/** Fit one finder's mature scored labels. Pure; exported for tests. */
export function fitFinder(labels: SentOutcomeLabel[]): FinderCalibration | null {
  const usable = labels.filter(
    (l) => (l.label === "positive" || l.label === "negative") && l.components !== null,
  );
  if (usable.length === 0) return null;
  const xs = usable.map((l) => PRIORITY_COMPONENT_KEYS.map((k) => l.components![k] / 100));
  const ys = usable.map((l): 0 | 1 => (l.label === "positive" ? 1 : 0));
  const { train, holdout } = holdoutSplit(
    usable.map((l, i) => ({ l, x: xs[i]!, y: ys[i]! })),
    (r) => r.l.dedupeKey,
  );
  const fitOn = train.length > 0 ? train : holdout;
  const fit = fitLogistic(
    fitOn.map((r) => r.x),
    fitOn.map((r) => r.y),
  );
  const holdoutPos = holdout.filter((r) => r.y === 1).map((r) => predictLogistic(fit, r.x));
  const holdoutNeg = holdout.filter((r) => r.y === 0).map((r) => predictLogistic(fit, r.x));
  return {
    weights: Object.fromEntries(
      PRIORITY_COMPONENT_KEYS.map((k, i) => [k, fit.weights[i]!]),
    ) as FinderCalibration["weights"],
    bias: fit.bias,
    nPos: ys.filter((y) => y === 1).length,
    nNeg: ys.filter((y) => y === 0).length,
    holdoutAuc: mannWhitneyAuc(holdoutPos, holdoutNeg),
  };
}

export function commandCalibrate(opts: { fit: boolean }): void {
  header("calibrate — outcome-fitted priority (shadow only)");
  const ledger = getLedger();
  const labels = assembleOutcomeLabels(ledger, "all");
  const readiness = assessReadiness(labels);

  if (readiness.length === 0) {
    note("No sent rows with outcome evidence yet — nothing to assess.");
    return;
  }

  process.stdout.write(
    `${c.dim(
      `readiness (floors: ≥${CALIBRATION_THRESHOLDS.minPositives} positives, ` +
        `≥${CALIBRATION_THRESHOLDS.minNegatives} negatives, ≥${CALIBRATION_THRESHOLDS.minMature} mature · ` +
        `maturity ${OUTCOME_MATURITY_DAYS}d · outcomes only, approvals are not labels):`,
    )}\n`,
  );
  for (const r of readiness) {
    process.stdout.write(
      `  ${r.finder.padEnd(22)} ${c.dim("positives:")} ${String(r.positives).padEnd(4)} ` +
        `${c.dim("negatives:")} ${String(r.negatives).padEnd(5)} ` +
        `${c.dim("mature:")} ${String(r.mature).padEnd(5)} ` +
        `${c.dim("scored:")} ${String(r.scoredMature).padEnd(5)} ` +
        `${r.ready ? c.green("ready") : c.dim("not yet")}\n`,
    );
  }
  process.stdout.write("\n");

  const ready = readiness.filter((r) => r.ready);
  if (!opts.fit) {
    if (ready.length === 0) {
      ok("Not yet — keep sending; labels mature on their own (no --force by design).");
    } else {
      ok(`${ready.length} finder(s) ready — run with --fit to write the artifact.`);
    }
    return;
  }
  if (ready.length === 0) {
    ok("Nothing fitted: no finder meets the floors (no --force by design).");
    return;
  }

  // Merge per-finder: a refit replaces that finder's entry, others persist.
  let existing: ProspectCalibration | null = null;
  try {
    existing = readProspectCalibration();
  } catch (err) {
    warn((err as Error).message);
  }
  const perFinder: Record<string, FinderCalibration> = { ...existing?.perFinder };
  for (const r of ready) {
    const finderLabels = labels.filter((l) => l.finder === r.finder);
    const fitted = fitFinder(finderLabels);
    if (!fitted) continue;
    perFinder[r.finder] = fitted;
    process.stdout.write(
      `  ${r.finder.padEnd(22)} ${c.dim("holdout AUC:")} ` +
        `${fitted.holdoutAuc === null ? "n/a" : fitted.holdoutAuc.toFixed(2)}  ` +
        `${c.dim("n:")} ${fitted.nPos}+/${fitted.nNeg}-\n`,
    );
    const usable = finderLabels.filter(
      (l) => (l.label === "positive" || l.label === "negative") && l.components !== null,
    );
    const pairs = usable.map((l) => ({
      p: predictLogistic(
        { weights: PRIORITY_COMPONENT_KEYS.map((k) => fitted.weights[k]), bias: fitted.bias },
        PRIORITY_COMPONENT_KEYS.map((k) => l.components![k] / 100),
      ),
      y: (l.label === "positive" ? 1 : 0) as 0 | 1,
    }));
    for (const bucket of calibrationBuckets(pairs)) {
      process.stdout.write(
        `  ${"".padEnd(22)} ${c.dim("predicted")} ${(bucket.meanPredicted * 100).toFixed(0)}% ` +
          `${c.dim("observed")} ${(bucket.observedRate * 100).toFixed(0)}% ${c.dim(`(n=${bucket.n})`)}\n`,
      );
    }
  }

  const artifact: ProspectCalibration = {
    version: "logistic-v1",
    fittedAt: new Date().toISOString(),
    outcome: "reply",
    maturityDays: OUTCOME_MATURITY_DAYS,
    perFinder,
  };
  // Round-trip through the validator so the writer and every reader can
  // never disagree about what a valid artifact is.
  const serialized = JSON.stringify(artifact, null, 2);
  if (parseProspectCalibration(serialized) === null) {
    throw new Error("refusing to write an artifact the validator rejects");
  }
  writeFileSync(calibrationPath(), serialized);
  ok(`wrote ${calibrationPath()} — shadow display only; nothing orders or sends by it.`);
}
