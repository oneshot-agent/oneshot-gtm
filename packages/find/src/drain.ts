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

/** Per-target draft shape returned by every play's runner. */
interface DraftedRow {
  subject: string;
  body: string;
  flags: string[];
  sent: boolean;
  receiptIds: number[];
}

/**
 * Pull approved rows for a play from target_queue, run them through the
 * existing motion play one target at a time, persist the draft for every row
 * (sent OR lint-held OR per-target error), then flip status to `sent` only
 * for the rows whose draft actually shipped. Per-target dispatch isolates
 * SDK throws (e.g. JobTimeoutError on agent.email()) so one bad target
 * can't kill the rest of the batch.
 */
export async function drainQueue(opts: DrainOpts): Promise<DrainOutcome> {
  const ledger = getLedger();
  const rows = ledger.dequeueApproved({ playName: opts.playName, limit: opts.limit ?? 50 });
  const outcome: DrainOutcome = { drained: rows.length, sent: 0, errors: [] };

  if (rows.length === 0) return outcome;

  // Global preconditions that should fail the whole drain, not per-row.
  if (opts.playName === "accelerator-batch" && !opts.senderCohort) {
    outcome.errors.push({
      id: -1,
      message: "--sender-cohort is required for draining accelerator-batch",
    });
    return outcome;
  }
  if (!isSupportedPlay(opts.playName)) {
    outcome.errors.push({ id: -1, message: `drain: unsupported play '${opts.playName}'` });
    return outcome;
  }

  for (const row of rows) {
    let draft: DraftedRow;
    try {
      draft = await dispatchOneTarget(opts, row);
    } catch (err) {
      const msg = ((err as Error).message ?? "play failed").slice(0, 200);
      draft = {
        subject: "(error)",
        body: "",
        flags: [`error: ${msg}`],
        sent: false,
        receiptIds: [],
      };
      outcome.errors.push({ id: row.id, message: msg });
    }

    try {
      ledger.setQueueDraft({
        id: row.id,
        draft: {
          subject: draft.subject,
          body: draft.body,
          flags: draft.flags,
          sent: draft.sent,
          receiptIds: draft.receiptIds,
          dryRun: opts.dryRun,
        },
      });
      if (draft.sent && !opts.dryRun) {
        ledger.setQueueStatus({ id: row.id, status: "sent" });
        const prospectId = backfillProspectId(row);
        if (prospectId != null) {
          try {
            ledger.setQueueProspectId(row.id, prospectId);
          } catch {
            // best-effort backfill — a schema mismatch shouldn't break the drain
          }
        }
        outcome.sent++;
      }
    } catch (err) {
      outcome.errors.push({
        id: row.id,
        message: ((err as Error).message ?? "persist failed").slice(0, 200),
      });
    }
  }

  if (opts.dryRun) outcome.sent = rows.length; // would-be-sent (no actual send in dryRun)

  return outcome;
}

const SUPPORTED_PLAYS = new Set([
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "breakup-revive",
  "competitor-switch",
  "stack-consolidation",
]);

function isSupportedPlay(name: string): boolean {
  return SUPPORTED_PLAYS.has(name);
}

async function dispatchOneTarget(opts: DrainOpts, row: QueueRow): Promise<DraftedRow> {
  switch (opts.playName) {
    case "show-hn": {
      const target = JSON.parse(row.payload_json) as ShowHnTarget;
      const result = await runShowHn({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "job-change": {
      const target = JSON.parse(row.payload_json) as JobChangeTarget;
      const result = await runJobChange({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "post-funding": {
      const target = JSON.parse(row.payload_json) as PostFundingTarget;
      const result = await runPostFunding({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "accelerator-batch": {
      const target = JSON.parse(row.payload_json) as AcceleratorBatchTarget;
      const result = await runAcceleratorBatch({
        dryRun: opts.dryRun,
        targets: [target],
        senderCohort: opts.senderCohort!,
        ...(opts.freeForCohortOffer ? { freeForCohortOffer: opts.freeForCohortOffer } : {}),
      });
      return firstDraft(result.drafted);
    }
    case "hiring-signal": {
      const target = JSON.parse(row.payload_json) as HiringSignalTarget;
      const result = await runHiringSignal({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "podcast-guest": {
      const target = JSON.parse(row.payload_json) as PodcastGuestTarget;
      const result = await runPodcastGuest({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "breakup-revive": {
      const target = JSON.parse(row.payload_json) as BreakupReviveTarget;
      const result = await runBreakupRevive({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "competitor-switch": {
      const target = JSON.parse(row.payload_json) as CompetitorSwitchTarget;
      const result = await runCompetitorSwitch({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    case "stack-consolidation": {
      const target = JSON.parse(row.payload_json) as StackConsolidationTarget;
      const result = await runStackConsolidation({ dryRun: opts.dryRun, targets: [target] });
      return firstDraft(result.drafted);
    }
    default:
      throw new Error(`drain: unsupported play '${opts.playName}'`);
  }
}

function firstDraft(drafted: DraftedRow[]): DraftedRow {
  const d = drafted[0];
  if (!d) throw new Error("play returned no draft for this target");
  return d;
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
