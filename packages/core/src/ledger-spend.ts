import type { Database } from "bun:sqlite";

/**
 * Daily-spend reservation persistence over a raw Database handle
 * (`spend_reservations`). Ledger delegates its spend-reservation methods
 * here; `daily-spend.ts` is the caller-facing gate built on top of these
 * primitives via the public `Ledger` API. Extracted from `Ledger` (issue #751).
 */

/** USD as integer cents, so money comparisons are exact. */
function cents(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * Hold `amountUsd` against the daily ceiling for the duration of an
 * automated call. Returns the reservation id: callers MUST release it
 * (on success or failure) via `releaseSpendReservation`, else it counts
 * against the ceiling until `sweepStaleSpendReservations` reclaims it.
 */
export function reserveSpend(db: Database, amountUsd: number): number {
  const result = db.prepare(`INSERT INTO spend_reservations(amount_usd) VALUES(?)`).run(amountUsd);
  return Number(result.lastInsertRowid);
}

/** Release a reservation once the caller's actual spend has posted (or the call was skipped/failed). */
export function releaseSpendReservation(db: Database, id: number): void {
  db.prepare(`DELETE FROM spend_reservations WHERE id = ?`).run(id);
}

/** Sum of currently-held reservations since `sinceIso` (the local-midnight boundary). */
export function reservedSpendUsd(db: Database, sinceIso: string): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend_reservations WHERE created_at >= ?`,
    )
    .get(sinceIso) as { total: number } | null;
  return row?.total ?? 0;
}

/**
 * Atomic check-then-reserve against the daily ceiling (issue #481
 * round-1 review finding). The read (posted spend + held reservations
 * since `sinceIso`) and the write (INSERT into `spend_reservations`)
 * happen inside ONE transaction on this connection. The same
 * `BEGIN IMMEDIATE` pattern `dequeueApproved` uses to close its own
 * cross-process claim race. IMMEDIATE takes SQLite's RESERVED write lock
 * at the START of the transaction (not the default DEFERRED, which only
 * locks on the first write), so in WAL mode two separate OS processes,
 * e.g. a `find watch --once` cron run and the server's in-process
 * scheduler firing the same tick, cannot both read the pre-reservation
 * total and both pass the check before either commits: the second
 * caller's transaction blocks until the first one's reservation is
 * already reflected in the sum it reads. Returns the new reservation id
 * when granted, or null when posted+reserved+`amountUsd` would EXCEED
 * `ceilingUsd`. Landing exactly on the ceiling is allowed: the ceiling is
 * "spend up to this", and a finder whose worst-case estimate equals the
 * ceiling (`config spend-ceiling 5` against a `maxCostUsd: 5` finder) must
 * still be able to fire once, with `>=` it never could, reporting
 * "$0.00/$5.00 spent today" while refusing forever (#488).
 *
 * `postedSpendUsd` (posted receipts, `ReceiptStore.totalSpendUsd`) is
 * supplied as a callback rather than this module importing that store
 * (mirroring the pattern `ledger-direct-mail.ts`'s `recordMailReceipt` uses
 * for the same cross-store-without-cycle reason), and MUST be invoked
 * inside the transaction below: reading it before the transaction opens
 * would defeat the IMMEDIATE lock's whole purpose, since a concurrent
 * caller's posted-receipt write between that read and this one's lock
 * acquisition would go unseen by the check.
 */
export function reserveSpendIfUnderCeiling(
  db: Database,
  opts: {
    sinceIso: string;
    ceilingUsd: number;
    amountUsd: number;
    postedSpendUsd: (sinceIso: string) => number;
  },
): number | null {
  const txn = db.transaction((): number | null => {
    const effectiveUsd = opts.postedSpendUsd(opts.sinceIso) + reservedSpendUsd(db, opts.sinceIso);
    // Compare in integer cents: receipts are REALs and three $0.10 calls
    // sum to 0.30000000000000004, which would read as over a $0.30 ceiling.
    if (cents(effectiveUsd) + cents(opts.amountUsd) > cents(opts.ceilingUsd)) return null;
    return reserveSpend(db, opts.amountUsd);
  });
  return txn.immediate();
}

/**
 * Sweep reservations older than `maxAgeMs`. A crashed process (kill -9
 * between reserve and release) must not hold spend against the ceiling for
 * the rest of the day. Returns the number of rows swept.
 */
export function sweepStaleSpendReservations(
  db: Database,
  maxAgeMs: number,
  now = new Date(),
): number {
  const cutoffIso = new Date(now.getTime() - maxAgeMs).toISOString().slice(0, 19).replace("T", " ");
  const result = db.prepare(`DELETE FROM spend_reservations WHERE created_at < ?`).run(cutoffIso);
  return Number(result.changes);
}
