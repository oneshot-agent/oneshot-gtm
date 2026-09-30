import type { Database } from "bun:sqlite";
import { toSqliteUtc } from "./time.ts";

/**
 * Deal-outcome (`deal_outcomes`) persistence over a raw Database handle: the
 * founder-recorded meeting/SQL/deal-won/deal-lost/ghosted funnel, independent
 * of the calendar-driven meeting outcomes in `ledger-meetings.ts`. Extracted
 * from `Ledger` (issue #751); `Ledger` delegates every method here unchanged.
 */

export function recordOutcome(
  db: Database,
  input: {
    prospectId: number;
    playName?: string;
    outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted";
    amountUsd?: number;
    notes?: string;
  },
): number {
  const stmt = db.prepare(`
    INSERT INTO deal_outcomes(prospect_id, play_name, outcome, amount_usd, notes)
    VALUES(?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.prospectId,
    input.playName ?? null,
    input.outcome,
    input.amountUsd ?? null,
    input.notes ?? null,
  );
  return Number(result.lastInsertRowid);
}

/** Latest outcome timestamp per prospect, bulk-read to acknowledge earlier positive replies. */
export function listLatestOutcomeRecordedAtByProspect(db: Database): Map<number, string> {
  const rows = db
    .query(
      `SELECT prospect_id, MAX(recorded_at) AS recorded_at FROM deal_outcomes GROUP BY prospect_id`,
    )
    .all() as Array<{ prospect_id: number; recorded_at: string }>;
  return new Map(rows.map((r) => [r.prospect_id, r.recorded_at]));
}

export function countOutcomes(
  db: Database,
  opts: { sinceIso?: string; playName?: string; outcome?: string } = {},
): number {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sinceIso) {
    where.push("recorded_at >= ?");
    args.push(toSqliteUtc(opts.sinceIso));
  }
  if (opts.playName) {
    where.push("play_name = ?");
    args.push(opts.playName);
  }
  if (opts.outcome) {
    where.push("outcome = ?");
    args.push(opts.outcome);
  }
  const sql = `SELECT COUNT(*) AS n FROM deal_outcomes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return (db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
}

export function outcomesByPlay(
  db: Database,
  opts: { sinceIso?: string } = {},
): Array<{
  play_name: string | null;
  meetings: number;
  sqls: number;
  won: number;
  lost: number;
  ghosted: number;
  won_value_usd: number;
}> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sinceIso) {
    where.push("recorded_at >= ?");
    args.push(toSqliteUtc(opts.sinceIso));
  }
  const sql = `
    SELECT
      play_name,
      SUM(CASE WHEN outcome = 'meeting_booked' THEN 1 ELSE 0 END) AS meetings,
      SUM(CASE WHEN outcome = 'sql_qualified' THEN 1 ELSE 0 END) AS sqls,
      SUM(CASE WHEN outcome = 'deal_won' THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN outcome = 'deal_lost' THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN outcome = 'ghosted' THEN 1 ELSE 0 END) AS ghosted,
      -- The return side. amount_usd has been written since v16 and read by
      -- nothing; without it the only figure putting dollars over dollars is
      -- the platform's per-goal RoCS, which divides one winner's cadence cost
      -- into its own deal and so ignores every prospect that went nowhere.
      COALESCE(SUM(CASE WHEN outcome = 'deal_won' THEN amount_usd ELSE 0 END), 0) AS won_value_usd
    FROM deal_outcomes
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY play_name
    ORDER BY play_name ASC NULLS LAST
  `;
  return db.query(sql).all(...(args as never[])) as never;
}

/** Recorded deal outcomes for one prospect, oldest first. */
export function listDealOutcomesForProspect(
  db: Database,
  prospectId: number,
): import("./types.ts").DealOutcomeRecord[] {
  return db
    .query(`SELECT * FROM deal_outcomes WHERE prospect_id = ? ORDER BY recorded_at ASC, id ASC`)
    .all(prospectId) as import("./types.ts").DealOutcomeRecord[];
}
