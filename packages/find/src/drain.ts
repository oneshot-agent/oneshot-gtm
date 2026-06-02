import { getLedger, type ProspectRecord, type QueueRow } from "@oneshot-gtm/core";
import { type DraftedRow, isSupportedPlay, PLAYS } from "@oneshot-gtm/plays";

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

  // Global precondition: the play must exist. accelerator-batch no longer
  // needs a drain-level senderCohort — finder rows carry their own (stamped
  // from trigger config), and the play falls back to the run-level option.
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

async function dispatchOneTarget(opts: DrainOpts, row: QueueRow): Promise<DraftedRow> {
  const play = PLAYS[opts.playName];
  if (!play) throw new Error(`drain: unsupported play '${opts.playName}'`);
  const target = JSON.parse(row.payload_json) as unknown;
  const result = await play.run({
    dryRun: opts.dryRun,
    targets: [target],
    ...(opts.senderCohort ? { senderCohort: opts.senderCohort } : {}),
    ...(opts.freeForCohortOffer ? { freeForCohortOffer: opts.freeForCohortOffer } : {}),
  });
  return firstDraft(result.drafted);
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
