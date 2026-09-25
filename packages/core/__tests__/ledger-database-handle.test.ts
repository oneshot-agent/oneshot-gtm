import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger, openLedgerDatabase } from "../src/ledger.ts";

// LinkedIn delivery rewrites channel_events in other workspaces' ledgers on a
// plain connection. Without a busy timeout, BEGIN IMMEDIATE fails the instant
// that workspace's server holds the write lock.

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-handle-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  new Ledger(dbPath).close();
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

/**
 * Another process takes the write lock for `holdMs`; resolves once it holds it.
 * `exited` is wrapped in an object: an async function returning a promise
 * would wait for it, i.e. for the lock to be released.
 */
async function holdWriteLock(holdMs: number): Promise<{ exited: Promise<number> }> {
  const marker = `${dbPath}.locked`;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite");
       const db = new Database(${JSON.stringify(dbPath)});
       db.exec("BEGIN IMMEDIATE");
       require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");
       Bun.sleepSync(${holdMs});
       db.exec("COMMIT");`,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  // A file, not stdout: the child's stdout may not flush until it exits,
  // by which point the lock is already gone.
  for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(10);
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  return { exited: child.exited };
}

function beginImmediate(db: Database): void {
  db.transaction(() => {
    db.query("SELECT 1 FROM channel_events LIMIT 1").get();
  }).immediate();
}

describe("openLedgerDatabase", () => {
  it("waits out another process's write lock instead of failing", async () => {
    const { exited } = await holdWriteLock(1500);
    const db = openLedgerDatabase(dbPath);
    try {
      expect(() => beginImmediate(db)).not.toThrow();
    } finally {
      db.close();
    }
    expect(await exited).toBe(0);
  });

  it("a bare connection fails on the same lock (the bug this replaces)", async () => {
    const { exited } = await holdWriteLock(1500);
    const db = new Database(dbPath);
    try {
      expect(() => beginImmediate(db)).toThrow(/locked|busy/i);
    } finally {
      db.close();
    }
    await exited;
  });

  it("opens read-only handles that still read", () => {
    const db = openLedgerDatabase(dbPath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM prospects").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
