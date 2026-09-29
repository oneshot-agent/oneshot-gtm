import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open state databases containing prospect emails, replies, and research.
 * Create missing files with mode 0600 before SQLite opens them so WAL and SHM
 * files inherit that mode. On each open, chmod existing database, WAL, and SHM
 * files to 0600. Create directories with mode 0700; leave existing directories
 * unchanged because ONESHOT_GTM_HOME may point to a user-managed location.
 *
 * Ignore chmod failures, including unsupported Windows permissions or another
 * owner; doctor reports files that remain readable by others.
 *
 * Use WAL with synchronous=NORMAL for app-crash durability and fewer fsyncs than
 * FULL. The busy timeout lets concurrent writers wait. Enable requested foreign
 * keys before migrations: foreign_keys has no effect inside a transaction.
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

/** True when the mode grants group or other access. */
export function isGroupOrWorldAccessible(mode: number): boolean {
  return (mode & 0o077) !== 0;
}
