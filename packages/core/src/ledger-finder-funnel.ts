import type { Database } from "bun:sqlite";
import { toSqliteUtc } from "./time.ts";

/**
 * What the daily funnel (`GET /api/measure/funnel`) reads: one `finder_runs`
 * row per finished finder run, and the queue rows those runs found, counted
 * per local day and source. Days are local (`'localtime'`), the same days
 * the spend ceiling resets on.
 */

export interface FinderRunInput {
  /** The trigger's name. */
  name: string;
  /** `FinderResult.source`, the key the run's queue rows carry. */
  source: string;
  startedAt: string;
  finishedAt: string;
  candidates: number;
  enqueued: number;
  droppedDuplicate: number;
  droppedEnrichment: number;
  droppedRole: number;
  droppedIcp: number;
  costUsd: number;
  halted: string | null;
}

export interface FinderRunRow {
  id: number;
  name: string;
  source: string;
  started_at: string;
  finished_at: string;
  /** The local day the run finished on, YYYY-MM-DD. */
  day: string;
  candidates: number;
  enqueued: number;
  dropped_dup: number;
  dropped_enrich: number;
  dropped_role: number;
  dropped_icp: number;
  cost_usd: number;
  halted: string | null;
}

/** Queue rows found on one local day from one source. */
export interface QueueFunnelRow {
  day: string;
  source: string;
  /** Every row a gate did not reject on sight (`decided_by` not machine). */
  queued: number;
  autoRejected: number;
  /** Approved or sent, on a human decision. */
  approved: number;
  rejected: number;
  sent: number;
  pending: number;
}

export function insertFinderRun(db: Database, run: FinderRunInput): number {
  const result = db
    .prepare(
      `INSERT INTO finder_runs(name, source, started_at, finished_at, candidates, enqueued,
         dropped_dup, dropped_enrich, dropped_role, dropped_icp, cost_usd, halted)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.name,
      run.source,
      run.startedAt,
      run.finishedAt,
      run.candidates,
      run.enqueued,
      run.droppedDuplicate,
      run.droppedEnrichment,
      run.droppedRole,
      run.droppedIcp,
      run.costUsd,
      run.halted ? run.halted.slice(0, 200) : null,
    );
  return Number(result.lastInsertRowid);
}

/** Runs that finished at or after `sinceIso`, oldest first. */
export function listFinderRunsSince(db: Database, sinceIso: string): FinderRunRow[] {
  return db
    .query(
      `SELECT id, name, source, started_at, finished_at, date(finished_at, 'localtime') AS day,
              candidates, enqueued, dropped_dup, dropped_enrich, dropped_role, dropped_icp,
              cost_usd, halted
         FROM finder_runs
        WHERE julianday(finished_at) >= julianday(?)
        ORDER BY finished_at ASC, id ASC`,
    )
    .all(sinceIso) as FinderRunRow[];
}

const HUMAN = "decided_by IN ('human', 'human_bulk')";

/** Queue rows found at or after `sinceIso`, counted per local day and source. */
export function queueFunnelSince(db: Database, sinceIso: string): QueueFunnelRow[] {
  return db
    .query(
      `SELECT date(found_at, 'localtime') AS day, source,
              SUM(COALESCE(decided_by, '') <> 'machine') AS queued,
              SUM(COALESCE(decided_by, '') = 'machine') AS autoRejected,
              SUM(status IN ('approved', 'sent') AND ${HUMAN}) AS approved,
              SUM(status = 'rejected' AND ${HUMAN}) AS rejected,
              SUM(status = 'sent') AS sent,
              SUM(status = 'pending') AS pending
         FROM target_queue
        WHERE found_at >= ?
        GROUP BY day, source
        ORDER BY day ASC, source ASC`,
    )
    .all(toSqliteUtc(sinceIso)) as QueueFunnelRow[];
}

/**
 * Rows a human approved per local day of the decision, whatever day they
 * were found. This is what a daily goal counts. A row still approved, sent
 * since, or expired after the approval (a reply that came first) keeps its
 * day; one reopened to pending does not count until it is approved again.
 */
export function approvedByDecisionDaySince(
  db: Database,
  sinceIso: string,
): Array<{ day: string; approved: number }> {
  return db
    .query(
      `SELECT date(decided_at, 'localtime') AS day, COUNT(*) AS approved
         FROM target_queue
        WHERE decided_at IS NOT NULL AND julianday(decided_at) >= julianday(?)
          AND (status IN ('approved', 'sent') OR (status = 'expired' AND decision = 'approve'))
          AND ${HUMAN}
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(sinceIso) as Array<{ day: string; approved: number }>;
}
