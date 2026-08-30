import { getLedger, isSendDeferred, type ProspectRecord, type QueueRow } from "@oneshot-gtm/core";
import { type DraftedRow, isSupportedPlay, MANUAL_PLAYS, PLAYS } from "@oneshot-gtm/plays";

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
  /** Rows left approved because every sender identity hit its daily cap. */
  deferred: number;
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
  const limit = opts.limit ?? 50;
  const isManual = Boolean(MANUAL_PLAYS[opts.playName]);
  // Manual plays (x-amplify-dm) never flip to sent on drain — their rows stay
  // approved until the founder hand-sends and hits Mark sent. Once such a row
  // has a clean draft, later drains must leave it alone: re-dispatching would
  // pay the LLM again and stomp a draft the founder may have already copied.
  // But those rows still occupy the oldest-first claim slice, so keep claiming
  // further batches past them — otherwise an un-hand-sent backlog the size of
  // one batch starves every newer row of drafting.
  const rows: QueueRow[] = [];
  for (;;) {
    const need = limit - rows.length;
    if (need <= 0) break;
    const batch = ledger.dequeueApproved({ playName: opts.playName, limit: need });
    for (const row of batch) {
      if (isManual && hasCleanDraft(row)) continue;
      rows.push(row);
    }
    if (batch.length < need) break;
  }
  const outcome: DrainOutcome = { drained: rows.length, sent: 0, deferred: 0, errors: [] };

  // Global precondition: the play must exist. Validate after initializing outcome
  // but before checking whether rows are empty, so an unknown play adds an error
  // to the outcome (exit 1 when the CLI sees it) instead of returning an empty
  // outcome (exit 2 under --fail-on-empty), regardless of queue state.
  // accelerator-batch no longer needs a drain-level senderCohort — finder rows
  // carry their own (stamped from trigger config), and the play falls back to
  // the run-level option.
  if (!isSupportedPlay(opts.playName)) {
    outcome.errors.push({ id: -1, message: `drain: unsupported play '${opts.playName}'` });
    return outcome;
  }

  if (rows.length === 0) return outcome;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    let draft: DraftedRow;
    try {
      draft = await dispatchOneTarget(opts, row);
    } catch (err) {
      // Daily caps exhausted: leave this row (and the rest of the batch)
      // approved with their reviewed drafts intact — the 15-min drain lease
      // expires and tomorrow's drain picks them up with fresh capacity.
      // Writing the "(error)" stub here would stomp a founder-reviewed draft.
      if (isSendDeferred(err)) {
        outcome.deferred += rows.length - r;
        break;
      }
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
          ...(draft.enrichmentFailed ? { enrichmentFailed: true } : {}),
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

/** A persisted draft with a body and no error flag — reviewed or reviewable as-is. */
function hasCleanDraft(row: QueueRow): boolean {
  if (!row.last_draft_json) return false;
  try {
    const d = JSON.parse(row.last_draft_json) as { body?: unknown; flags?: unknown };
    const body = typeof d.body === "string" ? d.body : "";
    const flags = Array.isArray(d.flags) ? (d.flags as unknown[]) : [];
    return (
      body.trim() !== "" && !flags.some((f) => typeof f === "string" && f.startsWith("error:"))
    );
  } catch {
    return false;
  }
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
