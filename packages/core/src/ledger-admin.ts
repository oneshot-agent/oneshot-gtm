import type { Database } from "bun:sqlite";

/**
 * Cross-cutting database administration over a raw Database/file handle:
 * WAL housekeeping, VACUUM, and close-time optimize. These aren't a
 * business domain — every domain store shares the same handle — so they
 * live in their own small module rather than forcing an artificial owner.
 * Extracted from `Ledger` (issue #751); `Ledger` delegates every method
 * here unchanged, including the two top-level helpers
 * (`openLedgerDatabaseHandle`'s readonly busy-timeout PRAGMA and
 * `truncateWal`) that other modules import directly off `ledger.ts`.
 */

/** How long a ledger connection waits on another process's write lock before SQLITE_BUSY. */
export const LEDGER_BUSY_TIMEOUT_MS = 5000;

/** Apply the same busy-timeout PRAGMA a write handle gets, to a readonly connection. */
export function applyReadonlyBusyTimeout(db: Database, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
}

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)`, failing loudly. A reader still inside a
 * transaction makes SQLite report `busy = 1` in the result row rather than
 * throw, which would leave the WAL at full size behind a "success".
 */
export function truncateWal(db: Database): void {
  const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
  if (row?.busy) {
    throw new Error("database is locked: another connection kept the WAL from being checkpointed");
  }
}

/**
 * Reclaim free pages after a large delete/trim. VACUUM needs the database
 * to itself, so a running dashboard or CLI on this ledger makes it fail
 * with "database is locked" once busy_timeout runs out. In WAL mode the
 * rebuilt database lands in the WAL, so the checkpoint after it is what
 * actually shrinks the file.
 */
export function vacuum(db: Database): void {
  truncateWal(db);
  db.exec("VACUUM");
  truncateWal(db);
}

/** Pages VACUUM would reclaim. */
export function freePages(db: Database): number {
  return (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
}

/** Refresh planner stats when SQLite thinks they're stale; cheap otherwise. Never let housekeeping fail a close. */
export function optimizeOnClose(db: Database): void {
  try {
    db.exec("PRAGMA optimize");
  } catch {
    // Never let housekeeping fail a close.
  }
}
