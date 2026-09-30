import type { Database } from "bun:sqlite";

/**
 * Generic CAS timestamp-marker helpers shared by every in-flight claim in the
 * ledger (cadence sends, queue sends, trigger runs). Extracted from `Ledger`
 * (issue #751) so `ledger-cadence.ts` and `ledger-triggers.ts` can both claim
 * a marker on their own table without either depending on the other. Table
 * and column names are whitelisted to bare ASCII identifiers since SQLite
 * can't bind them as parameters.
 */

function assertSafeIdentifiers(table: string, column: string): void {
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!ident.test(table) || !ident.test(column)) {
    throw new Error(`unsafe identifier in marker helper: ${table}.${column}`);
  }
}

/**
 * CAS-claim a timestamp marker on a single row: true when the marker was
 * NULL (or older than `staleCutoffIso`) and was set; false when another
 * caller holds the claim.
 */
export function claimMarker(
  db: Database,
  opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
    startedAtIso: string;
    staleCutoffIso?: string;
  },
): boolean {
  assertSafeIdentifiers(opts.table, opts.column);
  const staleClause = opts.staleCutoffIso
    ? ` AND (${opts.column} IS NULL OR ${opts.column} < ?)`
    : ` AND ${opts.column} IS NULL`;
  const args = opts.staleCutoffIso
    ? [opts.startedAtIso, ...opts.pkeyValues, opts.staleCutoffIso]
    : [opts.startedAtIso, ...opts.pkeyValues];
  const result = db
    .prepare(
      `UPDATE ${opts.table}
       SET ${opts.column} = ?
       WHERE ${opts.pkeyWhere}${staleClause}`,
    )
    .run(...(args as never[]));
  return result.changes > 0;
}

/**
 * Release a timestamp marker (set to NULL). Idempotent: no-op if the row
 * doesn't exist or the column is already NULL.
 */
export function clearMarker(
  db: Database,
  opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
  },
): void {
  assertSafeIdentifiers(opts.table, opts.column);
  db.prepare(`UPDATE ${opts.table} SET ${opts.column} = NULL WHERE ${opts.pkeyWhere}`).run(
    ...(opts.pkeyValues as never[]),
  );
}
