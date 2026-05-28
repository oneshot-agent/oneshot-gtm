import { getLedger, type ProspectRecord } from "@oneshot-gtm/core";
import {
  runAcceleratorBatch,
  runBreakupRevive,
  runCompetitorSwitch,
  runHiringSignal,
  runJobChange,
  runPodcastGuest,
  runPostFunding,
  runShowHn,
  runStackConsolidation,
  type AcceleratorBatchTarget,
  type BreakupReviveTarget,
  type CompetitorSwitchTarget,
  type HiringSignalTarget,
  type JobChangeTarget,
  type PodcastGuestTarget,
  type PostFundingTarget,
  type ShowHnTarget,
  type StackConsolidationTarget,
} from "@oneshot-gtm/plays";
import type { QueueRow } from "@oneshot-gtm/core";

export interface DrainOpts {
  playName: string;
  limit?: number;
  dryRun: boolean;
  /** Required for accelerator-batch. */
  senderCohort?: string;
  freeForCohortOffer?: string;
}

export interface DrainOutcome {
  drained: number;
  sent: number;
  errors: Array<{ id: number; message: string }>;
}

/**
 * Pull approved rows for a play from target_queue, run them through the
 * existing motion play, and mark each as sent (or rollback on error).
 */
export async function drainQueue(opts: DrainOpts): Promise<DrainOutcome> {
  const ledger = getLedger();
  const rows = ledger.dequeueApproved({ playName: opts.playName, limit: opts.limit ?? 50 });
  const outcome: DrainOutcome = { drained: rows.length, sent: 0, errors: [] };

  if (rows.length === 0) return outcome;

  try {
    const sentIds = await dispatchPlay(opts, rows);
    if (!opts.dryRun) {
      for (const id of sentIds) {
        const prospectId = backfillProspectId(rows.find((r) => r.id === id) ?? null);
        ledger.setQueueStatus({ id, status: "sent" });
        if (prospectId != null) {
          try {
            ledger.setQueueProspectId(id, prospectId);
          } catch {
            // best-effort backfill — a schema mismatch shouldn't break the drain
          }
        }
      }
      outcome.sent = sentIds.length;
    } else {
      outcome.sent = rows.length; // would-be-sent
    }
  } catch (err) {
    outcome.errors.push({ id: -1, message: (err as Error).message ?? "drain failed" });
  }

  return outcome;
}

async function dispatchPlay(opts: DrainOpts, rows: QueueRow[]): Promise<number[]> {
  switch (opts.playName) {
    case "show-hn": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as ShowHnTarget);
      const result = await runShowHn({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "job-change": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as JobChangeTarget);
      const result = await runJobChange({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "post-funding": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as PostFundingTarget);
      const result = await runPostFunding({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "accelerator-batch": {
      if (!opts.senderCohort) {
        throw new Error("--sender-cohort is required for draining accelerator-batch");
      }
      const targets = rows.map((r) => JSON.parse(r.payload_json) as AcceleratorBatchTarget);
      const result = await runAcceleratorBatch({
        dryRun: opts.dryRun,
        targets,
        senderCohort: opts.senderCohort,
        ...(opts.freeForCohortOffer ? { freeForCohortOffer: opts.freeForCohortOffer } : {}),
      });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "hiring-signal": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as HiringSignalTarget);
      const result = await runHiringSignal({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "podcast-guest": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as PodcastGuestTarget);
      const result = await runPodcastGuest({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "breakup-revive": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as BreakupReviveTarget);
      const result = await runBreakupRevive({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "competitor-switch": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as CompetitorSwitchTarget);
      const result = await runCompetitorSwitch({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    case "stack-consolidation": {
      const targets = rows.map((r) => JSON.parse(r.payload_json) as StackConsolidationTarget);
      const result = await runStackConsolidation({ dryRun: opts.dryRun, targets });
      return idsForSentDrafts(result.drafted, rows, opts.dryRun);
    }
    default:
      throw new Error(`drain: unsupported play '${opts.playName}'`);
  }
}

/**
 * Map drafted-results back to queue-row IDs by position. Plays return one
 * draft per input target (in order), so drafted[i] always corresponds to
 * rows[i]. We only flip a row to `sent` when its draft actually sent (or in
 * dry-run, when we'd have sent it). The earlier `.filter().map((_, i) => rows[i])`
 * pattern was wrong — after filtering, the index no longer maps to the
 * original row, so partial sends marked the wrong rows as sent.
 */
export function idsForSentDrafts(
  drafted: Array<{ sent: boolean }>,
  rows: QueueRow[],
  dryRun: boolean,
): number[] {
  const ids: number[] = [];
  for (let i = 0; i < drafted.length; i++) {
    const draft = drafted[i];
    const row = rows[i];
    if (!draft || !row) continue;
    if (draft.sent || dryRun) ids.push(row.id);
  }
  return ids;
}

function backfillProspectId(row: QueueRow | null): number | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json) as { email?: string; founderEmail?: string };
    const email = payload.email ?? payload.founderEmail;
    if (!email) return null;
    const ledger = getLedger();
    const p = ledger.findProspectByEmail(email);
    return p ? p.id : null;
  } catch {
    return null;
  }
}

export type { ProspectRecord };
