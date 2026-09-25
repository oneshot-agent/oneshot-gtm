import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open one of the install's own SQLite files (a workspace ledger, the shared
 * DB, the reply-review and LinkedIn inbox stores). They hold prospect emails,
 * reply bodies and research, so they are owner-only:
 *
 * - a missing file is created 0600 *before* SQLite opens it, since SQLite
 *   gives the `-wal` / `-shm` files it creates the main file's mode;
 * - an existing file and its `-wal` / `-shm` are chmodded to 0600 on every
 *   open, so an install created with the default umask heals itself;
 * - a directory this creates is 0700 (existing ones are left as they are: a
 *   custom ONESHOT_GTM_HOME may point somewhere the user set up).
 *
 * chmod failures (Windows, a file owned by someone else) are ignored, like
 * config.ts does for config.json. doctor reports a file that stayed readable.
 *
 * Pragmas: WAL; a busy timeout so a concurrent writer is waited out rather
 * than failing with "database is locked"; synchronous=NORMAL, the standard
 * pairing with WAL (durable across app crashes, fewer fsyncs than FULL); and
 * foreign keys when the schema relies on them. `foreign_keys` is a no-op inside
 * a transaction, so it has to be set here, before any migration runs.
 */
export function openStateDatabase(
  path: string,
  opts: { busyTimeoutMs: number; foreignKeys?: boolean },
): Database {
  const onDisk = path !== ":memory:" && !path.startsWith("file:");
  if (onDisk) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    for (const file of [path, `${path}-wal`, `${path}-shm`]) makePrivate(file);
  }
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs)}`);
  db.exec("PRAGMA synchronous = NORMAL");
  if (opts.foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function makePrivate(file: string): void {
  if (!existsSync(file)) return;
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not ours to change (Windows, another owner); doctor flags it.
  }
}

/** True when a file exists and its mode grants any group or other access. */
export function isGroupOrWorldAccessible(mode: number): boolean {
  return (mode & 0o077) !== 0;
}
