import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import {
  LEDGER_MIGRATIONS,
  LEDGER_SCHEMA_VERSION,
  runLedgerMigrations,
  type LedgerMigration,
} from "../src/ledger-schema.ts";

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
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

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function withRaw<T>(fn: (db: Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("runLedgerMigrations", () => {
  it("stamps a fresh ledger with the latest schema version", () => {
    new Ledger(dbPath).close();
    expect(withRaw(userVersion)).toBe(LEDGER_SCHEMA_VERSION);
    // Versions are strictly increasing, which the gate relies on.
    const versions = LEDGER_MIGRATIONS.map((m) => m.version);
    expect(versions.every((v, i) => i === 0 || v > versions[i - 1]!)).toBe(true);
  });

  it("does not re-run migrations on a ledger that is up to date", () => {
    new Ledger(dbPath).close();
    withRaw((db) => db.exec("ALTER TABLE prospects DROP COLUMN angle_json"));
    new Ledger(dbPath).close();
    expect(withRaw((db) => columns(db, "prospects"))).not.toContain("angle_json");
  });

  it("migrates a pre-versioning ledger (user_version 0)", () => {
    new Ledger(dbPath).close();
    withRaw((db) => {
      db.exec("ALTER TABLE prospects DROP COLUMN angle_json");
      db.exec("PRAGMA user_version = 0");
    });
    new Ledger(dbPath).close();
    withRaw((db) => {
      expect(columns(db, "prospects")).toContain("angle_json");
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    });
  });

  it("rolls every step back when one fails, leaving the version unchanged", () => {
    const migrations: LedgerMigration[] = [
      ...LEDGER_MIGRATIONS,
      {
        version: LEDGER_SCHEMA_VERSION + 1,
        name: "adds a table",
        up: (db) => db.exec("CREATE TABLE migration_probe (x)"),
      },
      {
        version: LEDGER_SCHEMA_VERSION + 2,
        name: "fails",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    withRaw((db) => {
      expect(() => runLedgerMigrations(db, migrations)).toThrow("boom");
      expect(userVersion(db)).toBe(0);
      expect(db.inTransaction).toBe(false);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables).toEqual([]);
    });
  });

  it("runs only the steps after the file's version", () => {
    new Ledger(dbPath).close();
    const ran: number[] = [];
    const migrations: LedgerMigration[] = [
      ...LEDGER_MIGRATIONS.map((m) => ({
        version: m.version,
        name: m.name,
        up: () => ran.push(m.version),
      })),
      { version: LEDGER_SCHEMA_VERSION + 1, name: "next", up: () => ran.push(-1) },
    ];
    withRaw((db) => {
      runLedgerMigrations(db, migrations);
      expect(ran).toEqual([-1]);
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION + 1);
    });
  });

  it("leaves a ledger from a newer build alone", () => {
    new Ledger(dbPath).close();
    withRaw((db) => db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION + 5}`));
    new Ledger(dbPath).close();
    expect(withRaw(userVersion)).toBe(LEDGER_SCHEMA_VERSION + 5);
  });

  it("rebuilds an old runs table inside the migration transaction", () => {
    // widenRunsStatusCheck used to open its own BEGIN, which would throw
    // inside runLedgerMigrations' transaction. An old narrow CHECK forces it
    // to rebuild.
    withRaw((db) => {
      db.exec(`CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, play_name TEXT NOT NULL, dry_run INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','done','interrupted')),
        started_at TEXT NOT NULL, completed_at TEXT, target_count INTEGER NOT NULL,
        drafted_count INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0, targets_json TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]', prospect_emails_json TEXT NOT NULL DEFAULT '[]'
      )`);
    });
    new Ledger(dbPath).close();
    withRaw((db) => {
      const sql = (
        db.query("SELECT sql FROM sqlite_master WHERE name = 'runs'").get() as { sql: string }
      ).sql;
      expect(sql).toContain("'cancelled'");
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    });
  });

  it("a second opener of the same fresh file finds it migrated", () => {
    const a = new Ledger(dbPath);
    const b = new Ledger(dbPath);
    b.close();
    a.close();
    expect(withRaw(userVersion)).toBe(LEDGER_SCHEMA_VERSION);
  });
});
