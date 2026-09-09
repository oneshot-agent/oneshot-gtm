import {
  getLedger,
  loadConfig,
  safeParseJsonRecord,
  tryReserveDailySpend,
  type QueueRow,
} from "@oneshot-gtm/core";
import {
  FIT_REASON_COST_ESTIMATE_USD,
  type FitReasonSource,
  generateFitReason,
  parseReasonFromNotes,
} from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * Backfill `fitReason` onto queue rows enqueued before finders stamped it
 * (issue #592) — the sentence the /queue row shows after its signal.
 *
 * Free rungs first, for every pending/approved row that lacks one:
 *   1. the company-gate reason recovered from the finder's `notes` template;
 *   2. the person-gate reason already on the payload (`icpVerdictReason`),
 *      unless that verdict was `reject`;
 *   3. one generated sentence — the only rung that spends, so it is capped by
 *      `--max-cost`, reserved against the daily ceiling, and skipped entirely
 *      with `--no-generate` or when no ICP is configured.
 *
 * Sibling of `score-prospects` (scoped, capped, resumable by state-in-the-row)
 * and of `research-prospects` (paid, `--max-cost`). Unlike score-prospects the
 * default is a DRY RUN: this command can spend. Writes go through
 * `Ledger.patchLiveQueuePayload`, one guarded statement, so a row that was
 * sent between listing and writing is skipped and counted, never clobbered.
 * Drafts are left alone — nothing in any prompt reads `fitReason`.
 */

export interface BackfillFitReasonOpts {
  play?: string;
  /** Persist. Default false = report what would be written. */
  write: boolean;
  limit?: number;
  /** Ceiling on ESTIMATED generation spend for this run (default 1.00). */
  maxCostUsd?: number;
  /** Re-derive rows that already carry a fitReason. */
  refresh: boolean;
  /** Allow the paid rung. `--no-generate` sets this false. */
  generate: boolean;
}

export interface BackfillFitReasonSummary {
  eligible: number;
  alreadyHad: number;
  fromNotes: number;
  fromPersonGate: number;
  generated: number;
  noIcp: number;
  unresolved: number;
  raceSkipped: number;
  written: number;
  estimatedCostUsd: number;
  byPlay: Record<string, { eligible: number; resolved: number }>;
}

/** A bad `--limit` must never WIDEN a run: NaN collapses to 0, not to the whole ledger. */
export function resolveCap(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}

function existingFitReason(payload: Record<string, unknown>): string | null {
  const v = payload["fitReason"];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** The two free rungs, in order. Null means only generation could fill this row. */
export function freeRung(
  row: QueueRow,
  payload: Record<string, unknown>,
): { fitReason: string; fitReasonSource: FitReasonSource } | null {
  const fromNotes = parseReasonFromNotes(row.play_name, row.notes);
  if (fromNotes) return { fitReason: fromNotes, fitReasonSource: "notes" };
  const person = payload["icpVerdictReason"];
  if (
    typeof person === "string" &&
    person.trim().length > 0 &&
    payload["icpVerdict"] !== "reject"
  ) {
    return { fitReason: person.trim(), fitReasonSource: "person-gate" };
  }
  return null;
}

export async function commandBackfillFitReason(
  opts: BackfillFitReasonOpts,
): Promise<BackfillFitReasonSummary> {
  header(`backfill-fit-reason ${opts.write ? "" : c.dim("(dry run)")}`);
  const ledger = getLedger();

  if (opts.play) {
    const known = ledger.listQueuePlayNames();
    if (!known.includes(opts.play)) {
      throw new Error(
        `unknown --play '${opts.play}'. Plays in this queue: ${known.join(", ") || "(none)"}`,
      );
    }
  }
  const cap = resolveCap(opts.limit);
  const maxCostUsd = opts.maxCostUsd ?? 1;
  const icp = loadConfig().icpOneLiner?.trim() || null;

  const rows = ledger.listQueueRowsForScoring(opts.play ? { playName: opts.play } : {});
  const summary: BackfillFitReasonSummary = {
    eligible: rows.length,
    alreadyHad: 0,
    fromNotes: 0,
    fromPersonGate: 0,
    generated: 0,
    noIcp: 0,
    unresolved: 0,
    raceSkipped: 0,
    written: 0,
    estimatedCostUsd: 0,
    byPlay: {},
  };
  const perPlay = (play: string) => (summary.byPlay[play] ??= { eligible: 0, resolved: 0 });

  let touched = 0;
  let ceilingWarned = false;
  for (const row of rows) {
    perPlay(row.play_name).eligible++;
    const payload = safeParseJsonRecord(row.payload_json) ?? {};
    if (existingFitReason(payload) && !opts.refresh) {
      summary.alreadyHad++;
      continue;
    }
    if (cap !== undefined && touched >= cap) break;
    touched++;

    let resolved = freeRung(row, payload);
    if (resolved) {
      if (resolved.fitReasonSource === "notes") summary.fromNotes++;
      else summary.fromPersonGate++;
    } else if (!opts.generate) {
      summary.unresolved++;
    } else if (!icp) {
      summary.noIcp++;
    } else if (summary.estimatedCostUsd + FIT_REASON_COST_ESTIMATE_USD > maxCostUsd) {
      summary.unresolved++;
    } else {
      const reservation = tryReserveDailySpend(FIT_REASON_COST_ESTIMATE_USD);
      if (!reservation.granted) {
        if (!ceilingWarned) {
          warn(`daily spend ceiling: ${reservation.reason} — generation skipped from here on`);
          ceilingWarned = true;
        }
        summary.unresolved++;
      } else {
        let sentence: string | null = null;
        try {
          const dossier = payload["dossier"];
          sentence = await generateFitReason({
            icp,
            playName: row.play_name,
            payload,
            dossier: typeof dossier === "string" ? dossier : null,
          });
        } finally {
          reservation.release();
        }
        summary.estimatedCostUsd += FIT_REASON_COST_ESTIMATE_USD;
        if (sentence) {
          resolved = { fitReason: sentence, fitReasonSource: "generated" };
          summary.generated++;
        } else {
          summary.unresolved++;
        }
      }
    }

    if (!resolved) continue;
    perPlay(row.play_name).resolved++;
    if (!opts.write) continue;
    const wrote = ledger.patchLiveQueuePayload({ id: row.id, patch: resolved });
    if (wrote) summary.written++;
    else summary.raceSkipped++;
  }

  for (const [play, n] of Object.entries(summary.byPlay)) {
    note(
      `  ${play.padEnd(22)} eligible ${String(n.eligible).padStart(4)} · resolved ${String(n.resolved).padStart(4)}`,
    );
  }
  const line =
    `eligible ${summary.eligible} · already had ${summary.alreadyHad} · notes ${summary.fromNotes}` +
    ` · person-gate ${summary.fromPersonGate} · generated ${summary.generated} (~$${summary.estimatedCostUsd.toFixed(3)})` +
    ` · no ICP ${summary.noIcp} · unresolved ${summary.unresolved} · race-skipped ${summary.raceSkipped}`;
  if (opts.write) ok(`${line} · written ${summary.written}`);
  else ok(`${line} · dry run — nothing written.`);
  return summary;
}
