import {
  getLedger,
  parseProspectPriority,
  type ProspectPriority,
  type QueueRow,
  safeParseJsonRecord,
} from "@oneshot-gtm/core";
import { PRIORITY_ADAPTERS, mannWhitneyAuc, meanOf, safeScorePriority } from "@oneshot-gtm/find";
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
 * True when the row already carries a valid current-version artifact. Uses
 * the same full-shape validator as the API projection — an artifact the API
 * would hide as `priority: null` (partial, corrupt, out-of-range) must read
 * as "not scored" here too, or a plain backfill run could never repair it.
 */
export function hasCurrentScore(row: Pick<QueueRow, "priority_json">): boolean {
  return parseProspectPriority(row.priority_json) !== null;
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

export const SCORE_BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100"] as const;

export function bucketOf(total: number): (typeof SCORE_BUCKETS)[number] {
  if (total < 20) return "0-19";
  if (total < 40) return "20-39";
  if (total < 60) return "40-59";
  if (total < 80) return "60-79";
  return "80-100";
}

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
  const byFinder = new Map<string, FinderShadowReport>();
  const humanApproved = new Map<string, number>();
  const scores = new Map<string, { approved: number[]; rejected: number[] }>();
  for (const row of rows) {
    let entry = byFinder.get(row.play_name);
    if (!entry) {
      entry = {
        finder: row.play_name,
        rows: 0,
        scored: 0,
        buckets: { "0-19": 0, "20-39": 0, "40-59": 0, "60-79": 0, "80-100": 0 },
        humanReviewed: 0,
        humanApprovalRate: null,
        approvedScored: { n: 0, mean: null },
        rejectedScored: { n: 0, mean: null },
        auc: null,
      };
      byFinder.set(row.play_name, entry);
    }
    entry.rows++;
    const priority = parseProspectPriority(row.priority_json);
    // Buckets describe the live queue only — a dispatched (sent) or dropped
    // row keeps its historical priority_json, and counting it here would make
    // the distribution misrepresent the claimed pending/approved population.
    if (priority !== null && (row.status === "pending" || row.status === "approved")) {
      entry.scored++;
      entry.buckets[bucketOf(priority.total)]++;
    }
    // Human label = a person decided. Expired rows carry reviewed_at from the
    // reservation/expiry machinery, not from a review — counting them as
    // non-approvals deflated approval rates (measured: luma 38% vs true 65%).
    const humanDecided =
      row.reviewed_at !== null &&
      (row.status === "approved" || row.status === "sent" || row.status === "rejected") &&
      !isAutoRejected(row);
    if (humanDecided) {
      entry.humanReviewed++;
      const sides = scores.get(row.play_name) ?? { approved: [], rejected: [] };
      if (row.status === "approved" || row.status === "sent") {
        humanApproved.set(row.play_name, (humanApproved.get(row.play_name) ?? 0) + 1);
        if (priority !== null) sides.approved.push(priority.total);
      } else if (row.status === "rejected" && priority !== null) {
        sides.rejected.push(priority.total);
      }
      scores.set(row.play_name, sides);
    }
  }
  for (const entry of byFinder.values()) {
    if (entry.humanReviewed > 0) {
      entry.humanApprovalRate = (humanApproved.get(entry.finder) ?? 0) / entry.humanReviewed;
    }
    const sides = scores.get(entry.finder) ?? { approved: [], rejected: [] };
    entry.approvedScored = { n: sides.approved.length, mean: meanOf(sides.approved) };
    entry.rejectedScored = { n: sides.rejected.length, mean: meanOf(sides.rejected) };
    entry.auc = mannWhitneyAuc(sides.approved, sides.rejected);
  }
  return [...byFinder.values()].toSorted((a, b) => a.finder.localeCompare(b.finder));
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
