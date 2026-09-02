import {
  cadenceGoalId,
  getLedger,
  readProspectCalibration,
  isHumanApproval,
  isHumanDecision,
  parseProspectPriority,
  type ProspectPriority,
  type QueueRow,
  safeParseJsonRecord,
} from "@oneshot-gtm/core";
import {
  OUTCOME_MATURITY_DAYS,
  type OutcomeRank,
  PRIORITY_ADAPTERS,
  PRIORITY_VERSION,
  SCORE_BUCKETS,
  bucketOf,
  buildOutcomeReport,
  labelSentRow,
  mannWhitneyAuc,
  maxOutcomeRank,
  meanOf,
  safeScorePriority,
  valueTagToRank,
} from "@oneshot-gtm/find";
import { c, header, note, ok } from "../output.ts";

/**
 * Backfill shadow-mode priority scores onto queue rows (issue #410, Phase 1).
 *
 * Reads ONLY the payloads the finders already persisted — no network, no LLM,
 * no SDK, $0. Resumable by state-in-the-row: a re-run skips rows that already
 * carry a current-version artifact unless `--refresh`. Scores are anchored to
 * each row's `found_at` (both freshness and `scoredAt`), so a backfilled score
 * matches what enqueue-time scoring would have produced and re-runs are
 * deterministic.
 *
 * Sibling of `research-prospects`: same shape (scoped, capped, dry-runnable),
 * but synchronous and free.
 */

export interface ScoreProspectsOpts {
  scope?: string;
  limit?: number;
  /** Re-score rows that already hold a current-version artifact. */
  refresh: boolean;
  /** Report distributions without writing. */
  dryRun: boolean;
  /** Print the per-finder shadow report (works with --dry-run). */
  report: boolean;
  /**
   * Widen the backfill from the live queue (pending/approved) to EVERY row —
   * sent, rejected, expired — so historical scores can be compared against
   * the dispositions humans already made. Evaluation only: nothing anywhere
   * acts on a score, and auto-rejections stay separated from human labels.
   */
  allStatuses?: boolean;
}

/**
 * Parse `--scope`. Unknown names are rejected rather than ignored — a typo'd
 * play must not silently widen the run to nothing (or to everything).
 */
export function parseScope(raw: string | undefined): string {
  const scope = (raw ?? "all").trim();
  if (scope === "all") return scope;
  const valid = Object.keys(PRIORITY_ADAPTERS);
  if (!valid.includes(scope)) {
    throw new Error(`unknown --scope value: ${scope}. Valid: all, ${valid.join(", ")}`);
  }
  return scope;
}

/** Mirrors research-prospects: a bad `--limit` collapses to 0, never widens. */
export function resolveCap(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}

/**
 * True when the row already carries a valid CURRENT-version artifact. Uses
 * the same full-shape validator as the API projection — an artifact the API
 * would hide as `priority: null` (partial, corrupt, out-of-range) must read
 * as "not scored" here too, or a plain backfill run could never repair it.
 * Older versions parse (they keep rendering) but are not current, so a plain
 * run auto-rescores v1 → v2.
 */
export function hasCurrentScore(row: Pick<QueueRow, "priority_json">): boolean {
  return parseProspectPriority(row.priority_json)?.version === PRIORITY_VERSION;
}

export function shouldSkipRow(row: Pick<QueueRow, "priority_json">, refresh: boolean): boolean {
  return !refresh && hasCurrentScore(row);
}

/**
 * The freshness/scoredAt anchor for a backfilled row. `found_at` comes from
 * SQLite's `datetime('now')` — UTC without a zone marker — so normalize it to
 * ISO before parsing; a malformed value falls back to the run clock.
 */
export function anchorFor(row: Pick<QueueRow, "found_at">): Date {
  const raw = (row.found_at ?? "").trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : new Date();
}

// Moved to @oneshot-gtm/find (_buckets.ts) so the outcome report shares the
// bands; re-exported here for existing importers/tests.
export { SCORE_BUCKETS, bucketOf };

/**
 * Machine rejections carry the `auto:` notes prefix (same discriminator as
 * `Ledger.recentIcpDecisions`). They must NEVER be counted as human negatives
 * in any score evaluation.
 */
export function isAutoRejected(row: Pick<QueueRow, "status" | "notes">): boolean {
  return row.status === "rejected" && (row.notes ?? "").startsWith("auto:");
}

export interface FinderShadowReport {
  finder: string;
  rows: number;
  scored: number;
  buckets: Record<(typeof SCORE_BUCKETS)[number], number>;
  /** Rows a human actually reviewed — auto: rejections excluded. */
  humanReviewed: number;
  /** approved+sent over humanReviewed, or null when no human labels exist. */
  humanApprovalRate: number | null;
  /**
   * Methodology gauge: mean score among scored human-approved (incl. sent)
   * vs scored human-rejected rows. If the heuristic carries signal, approved
   * should average higher than rejected. Auto-rejections never count.
   */
  approvedScored: { n: number; mean: number | null };
  rejectedScored: { n: number; mean: number | null };
  /**
   * Mann-Whitney AUC of score vs human call: P(random approved outranks a
   * random rejected). 0.5 = no separation. Null until both sides have scored
   * rows. The Phase 2 acceptance bar reads this number.
   */
  auc: number | null;
}

/**
 * Aggregate shadow report by finder. Descriptive only: score buckets next to
 * the human approval rate where labels exist. This is NOT a conversion
 * probability — no calibration has been measured.
 */
export function buildShadowReport(rows: QueueRow[]): FinderShadowReport[] {
  // One accumulator per finder; the report objects are constructed once at
  // the end so no field ever depends on a placeholder being overwritten.
  interface Acc {
    rows: number;
    scored: number;
    buckets: Record<(typeof SCORE_BUCKETS)[number], number>;
    humanReviewed: number;
    /** Human approvals INCLUDING unscored rows — not derivable from approved.length. */
    approvedCount: number;
    approved: number[];
    rejected: number[];
  }
  const byFinder = new Map<string, Acc>();
  for (const row of rows) {
    let acc = byFinder.get(row.play_name);
    if (!acc) {
      acc = {
        rows: 0,
        scored: 0,
        buckets: { "0-19": 0, "20-39": 0, "40-59": 0, "60-79": 0, "80-100": 0 },
        humanReviewed: 0,
        approvedCount: 0,
        approved: [],
        rejected: [],
      };
      byFinder.set(row.play_name, acc);
    }
    acc.rows++;
    const priority = parseProspectPriority(row.priority_json);
    // Buckets describe the live queue only — a dispatched (sent) or dropped
    // row keeps its historical priority_json, and counting it here would make
    // the distribution misrepresent the claimed pending/approved population.
    if (priority !== null && (row.status === "pending" || row.status === "approved")) {
      acc.scored++;
      acc.buckets[bucketOf(priority.total)]++;
    }
    // Human label = a person decided (shared predicate — expiry machinery
    // stamps reviewed_at without judgment; counting those as non-approvals
    // deflated approval rates: measured luma 38% vs true 65%).
    if (isHumanDecision(row)) {
      acc.humanReviewed++;
      if (isHumanApproval(row)) {
        acc.approvedCount++;
        if (priority !== null) acc.approved.push(priority.total);
      } else if (priority !== null) {
        acc.rejected.push(priority.total);
      }
    }
  }
  return [...byFinder.entries()]
    .map(
      ([finder, acc]): FinderShadowReport => ({
        finder,
        rows: acc.rows,
        scored: acc.scored,
        buckets: acc.buckets,
        humanReviewed: acc.humanReviewed,
        humanApprovalRate: acc.humanReviewed > 0 ? acc.approvedCount / acc.humanReviewed : null,
        approvedScored: { n: acc.approved.length, mean: meanOf(acc.approved) },
        rejectedScored: { n: acc.rejected.length, mean: meanOf(acc.rejected) },
        auc: mannWhitneyAuc(acc.approved, acc.rejected),
      }),
    )
    .toSorted((a, b) => a.finder.localeCompare(b.finder));
}

/**
 * Per-finder outcome section (Phase 3 of #410): what the sends actually did.
 * Positives are real outcomes only (human replies, meetings, deals, receipt
 * value tags); a row counts negative only once mature and joinable —
 * immature and unjoinable rows never enter a denominator. This is NOT a
 * conversion probability.
 */
/**
 * Assemble outcome labels for every sent row in scope. Shared by the report
 * below and `find calibrate`, so the two can never disagree about what a
 * label is.
 */
export function assembleOutcomeLabels(
  ledger: ReturnType<typeof getLedger>,
  scope: string,
  now: Date = new Date(),
): ReturnType<typeof labelSentRow>[] {
  const raw = ledger.listSentOutcomeRows(scope === "all" ? {} : { playName: scope });
  // Fold the receipts value-tag ladder into one max rank per goal.
  const rankByGoal = new Map<string, OutcomeRank>();
  for (const receipt of ledger.listValueTaggedReceipts()) {
    const rank = valueTagToRank(receipt.value_tag);
    rankByGoal.set(
      receipt.goal_id,
      maxOutcomeRank(rankByGoal.get(receipt.goal_id) ?? "none", rank),
    );
  }
  return raw.map((row) => {
    // Mirror tagOutcomeValue's goal derivation, pid: fallback included.
    const email = row.payload_email?.trim();
    const goalId = cadenceGoalId(row.play_name, email || `pid:${row.joined_prospect_id ?? 0}`);
    return labelSentRow(row, rankByGoal.get(goalId) ?? "none", now);
  });
}

function printOutcomeReport(ledger: ReturnType<typeof getLedger>, scope: string): void {
  const labels = assembleOutcomeLabels(ledger, scope);
  if (labels.length === 0) return;

  // Shadow display of the fitted calibration, when one exists (written by
  // `find calibrate --fit`). Display only — nothing consumes it for ordering.
  let calibration: ReturnType<typeof readProspectCalibration> = null;
  try {
    calibration = readProspectCalibration();
  } catch (err) {
    note((err as Error).message);
  }

  process.stdout.write(
    `${c.dim(`outcome report (not a conversion probability) · maturity ${OUTCOME_MATURITY_DAYS}d:`)}\n`,
  );
  for (const r of buildOutcomeReport(labels)) {
    const rate =
      r.replyRate === null
        ? "n/a"
        : `${(r.replyRate.rate * 100).toFixed(1)}% [${(r.replyRate.lo * 100).toFixed(0)}–${(r.replyRate.hi * 100).toFixed(0)}%]`;
    process.stdout.write(
      `  ${r.finder.padEnd(22)} ${c.dim("sends:")} ${String(r.sends).padEnd(5)} ` +
        `${c.dim("mature:")} ${String(r.mature).padEnd(5)} ` +
        `${c.dim(`(immature ${r.immature}, unjoinable ${r.unjoinable})`)}  ` +
        `${c.dim("replies:")} ${r.replies} ${c.dim(rate)}  ${c.dim("meetings+:")} ${r.meetingsPlus}` +
        `${r.scoreVsOutcomeAuc === null ? "" : `  ${c.dim("score vs outcome AUC:")} ${r.scoreVsOutcomeAuc.toFixed(2)}`}\n`,
    );
    const cells = SCORE_BUCKETS.filter((b) => r.repliesByBucket[b].n > 0)
      .map((b) => `${c.dim(b + ":")} ${r.repliesByBucket[b].replied}/${r.repliesByBucket[b].n}`)
      .join("  ");
    if (cells) {
      process.stdout.write(`  ${"".padEnd(22)} ${c.dim("replies by score bucket —")} ${cells}\n`);
    }
    const fitted = calibration?.perFinder[r.finder];
    if (fitted) {
      process.stdout.write(
        `  ${"".padEnd(22)} ${c.dim("calibrated holdout AUC:")} ` +
          `${fitted.holdoutAuc === null ? "n/a" : fitted.holdoutAuc.toFixed(2)} ` +
          `${c.dim(`(fitted ${calibration!.fittedAt.slice(0, 10)}, n=${fitted.nPos}+/${fitted.nNeg}-)`)}\n`,
      );
    }
  }
  process.stdout.write("\n");
}

function gaugeSide(label: string, s: { n: number; mean: number | null }): string {
  return s.mean === null ? `${label}: n/a` : `${label}: avg ${s.mean.toFixed(0)} (n=${s.n})`;
}

function printDistribution(label: string, counts: Map<string, Record<string, number>>): void {
  process.stdout.write(`${c.dim(label)}\n`);
  for (const [play, buckets] of [...counts.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const cells = SCORE_BUCKETS.map((b) => `${c.dim(b + ":")} ${buckets[b] ?? 0}`).join("  ");
    process.stdout.write(`  ${play.padEnd(22)} ${cells}\n`);
  }
  process.stdout.write("\n");
}

export function commandScoreProspects(opts: ScoreProspectsOpts): void {
  header(`score-prospects ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();
  const scope = parseScope(opts.scope);

  // Read the backlog, then cap in memory after the skip filter — `--limit N`
  // means "score N rows", not "consider N rows".
  const rows = ledger.listQueueRowsForScoring({
    ...(scope === "all" ? {} : { playName: scope }),
    ...(opts.allStatuses ? { allStatuses: true } : {}),
  });
  const todo = rows.filter((r) => !shouldSkipRow(r, opts.refresh));
  const cap = resolveCap(opts.limit);
  const candidates = cap === undefined ? todo : todo.slice(0, cap);

  process.stdout.write(
    `${c.dim("scope:")} ${scope}` +
      `  ${c.dim(opts.allStatuses ? "rows (all statuses):" : "pending/approved rows:")} ${rows.length}` +
      `  ${c.dim("already scored:")} ${rows.length - todo.length}` +
      `  ${c.dim("to score:")} ${candidates.length}` +
      (cap !== undefined && todo.length > candidates.length
        ? `  ${c.dim("held back by --limit:")} ${todo.length - candidates.length}`
        : "") +
      `\n${c.dim("Stored payloads only — no network, no LLM, $0.")}\n\n`,
  );

  let written = 0;
  let unsupported = 0;
  let failed = 0;
  const distribution = new Map<string, Record<string, number>>();

  for (const row of candidates) {
    const payload = safeParseJsonRecord(row.payload_json);
    const priority: ProspectPriority | null = payload
      ? safeScorePriority(row.play_name, payload, anchorFor(row))
      : null;
    if (priority === null) {
      // Unknown play (no adapter) vs malformed payload / scoring failure —
      // either way the row keeps whatever it had; failures never clear a score.
      if (PRIORITY_ADAPTERS[row.play_name]) failed++;
      else unsupported++;
      continue;
    }
    const buckets = distribution.get(row.play_name) ?? {};
    buckets[bucketOf(priority.total)] = (buckets[bucketOf(priority.total)] ?? 0) + 1;
    distribution.set(row.play_name, buckets);
    if (!opts.dryRun) {
      ledger.setQueuePriority(row.id, priority);
      written++;
    }
  }

  if (distribution.size > 0) {
    printDistribution(
      opts.dryRun ? "score distribution (dry-run, nothing written):" : "score distribution:",
      distribution,
    );
  }

  if (opts.report) {
    // Same scope as the backfill, and effectively unbounded — a real limit
    // would silently truncate the history the rates are computed over.
    const report = buildShadowReport(
      ledger.listQueue({
        limit: Number.MAX_SAFE_INTEGER,
        ...(scope === "all" ? {} : { playName: scope }),
      }),
    );
    process.stdout.write(
      `${c.dim("shadow report by finder (not a conversion probability):")}\n` +
        `${c.dim("  score buckets cover scored pending/approved rows; rows + approval rate cover the full reviewed history")}\n`,
    );
    for (const r of report) {
      const rate =
        r.humanApprovalRate === null
          ? "n/a (no human labels)"
          : `${(r.humanApprovalRate * 100).toFixed(0)}% of ${r.humanReviewed}`;
      const cells = SCORE_BUCKETS.map((b) => `${c.dim(b + ":")} ${r.buckets[b]}`).join("  ");
      process.stdout.write(
        `  ${r.finder.padEnd(22)} ${c.dim("rows:")} ${String(r.rows).padEnd(5)} ` +
          `${c.dim("scored:")} ${String(r.scored).padEnd(5)} ${cells}` +
          `  ${c.dim("human approval (shadow):")} ${rate}\n`,
      );
      // The methodology gauge: does the heuristic rank what humans approved
      // above what they rejected? Needs scored rows on both sides to mean
      // anything, so print whatever exists and let the reader judge n.
      if (r.approvedScored.n > 0 || r.rejectedScored.n > 0) {
        process.stdout.write(
          `  ${"".padEnd(22)} ${c.dim("score vs human call —")} ` +
            `${gaugeSide("approved", r.approvedScored)}  ${gaugeSide("rejected", r.rejectedScored)}` +
            `${r.auc === null ? "" : `  ${c.dim("AUC:")} ${r.auc.toFixed(2)}`}\n`,
        );
      }
    }
    process.stdout.write("\n");
    printOutcomeReport(ledger, scope);
  }

  if (opts.dryRun) {
    ok("dry run — nothing written.");
    return;
  }
  ok(
    `scored ${written}  ${c.dim("skipped (already scored):")} ${rows.length - todo.length}  ` +
      `${c.dim("no adapter:")} ${unsupported}  ${c.dim("failed:")} ${failed}`,
  );
  if (unsupported > 0) {
    note("Rows without an adapter (manual/legacy plays) stay unscored by design.");
  }
}
