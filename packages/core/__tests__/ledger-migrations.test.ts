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

  it("adds columns introduced after v2 to a ledger already at v2", () => {
    // A shipped step never re-runs: a column added by editing the baseline
    // would never reach an install already past it.
    new Ledger(dbPath).close();
    withRaw((db) => {
      db.exec("ALTER TABLE triggers DROP COLUMN company_batch_seq");
      db.exec("PRAGMA user_version = 2");
    });
    new Ledger(dbPath).close();
    expect(withRaw((db) => columns(db, "triggers"))).toContain("company_batch_seq");
    expect(withRaw(userVersion)).toBe(LEDGER_SCHEMA_VERSION);
  });

  it("v9 adds the reply-intent detail columns to a v8 ledger and keeps existing labels", () => {
    const v9 = [
      "intent_confidence",
      "intent_probs",
      "intent_classifier",
      "intent_cost_micros",
      "intent_classified_at",
      "intent_review",
    ];
    new Ledger(dbPath).close();
    withRaw((db) => {
      for (const col of v9) db.exec(`ALTER TABLE inbox_replies DROP COLUMN ${col}`);
      db.exec(
        `INSERT INTO inbox_replies (id, thread_key, prospect_id, from_email, body, received_at, intent)
         VALUES ('r1', 't1', 1, 'a@b.c', 'hi', '2026-09-30T00:00:00.000Z', 'objection')`,
      );
      db.exec("PRAGMA user_version = 8");
    });
    new Ledger(dbPath).close();
    withRaw((db) => {
      expect(columns(db, "inbox_replies")).toEqual(expect.arrayContaining(v9));
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      const row = db.query("SELECT intent, intent_review FROM inbox_replies WHERE id = 'r1'").get();
      expect(row).toEqual({ intent: "objection", intent_review: 0 });
    });
  });

  it("v9's step is idempotent (re-running it on a migrated file is a no-op)", () => {
    new Ledger(dbPath).close();
    const step = LEDGER_MIGRATIONS.find((m) => m.name === "inbox-reply-intent-details")!;
    withRaw((db) => {
      expect(() => step.up(db)).not.toThrow();
      expect(() => step.up(db)).not.toThrow();
    });
  });

  it("v13 copies the #750 ICP proposals into learning_proposals as kind icp, idempotently", () => {
    new Ledger(dbPath).close();
    withRaw((db) => {
      db.exec("DROP TABLE learning_proposals");
      db.exec(
        `INSERT INTO icp_proposals (id, current_icp, proposed_icp, evidence_summary, created_at, status, decided_at)
         VALUES ('p1', 'B2B fintech founders', 'B2B fintech CTOs!', 'skews technical', '2026-09-29T00:00:00Z', 'approved', '2026-09-30T00:00:00Z'),
                ('p2', 'B2B fintech CTOs!', 'Series A CTOs', 'later', '2026-10-01T00:00:00Z', 'pending', NULL)`,
      );
      db.exec("PRAGMA user_version = 12");
    });
    new Ledger(dbPath).close();
    withRaw((db) => {
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      const rows = db
        .query(
          "SELECT id, kind, current_json, proposed_json, baseline_key, dedupe_key, status, decided_at, applied_at FROM learning_proposals ORDER BY created_at",
        )
        .all();
      expect(rows).toEqual([
        {
          id: "p1",
          kind: "icp",
          current_json: JSON.stringify("B2B fintech founders"),
          proposed_json: JSON.stringify("B2B fintech CTOs!"),
          baseline_key: "b2b fintech founders",
          dedupe_key: "b2b fintech ctos",
          status: "approved",
          decided_at: "2026-09-30T00:00:00Z",
          applied_at: "2026-09-30T00:00:00Z",
        },
        {
          id: "p2",
          kind: "icp",
          current_json: JSON.stringify("B2B fintech CTOs!"),
          proposed_json: JSON.stringify("Series A CTOs"),
          baseline_key: "b2b fintech ctos",
          dedupe_key: "series a ctos",
          status: "pending",
          decided_at: null,
          applied_at: null,
        },
      ]);
      expect(columns(db, "draft_versions")).toContain("learning_key");
      expect(columns(db, "target_queue")).toContain("decision_reason");
      expect(columns(db, "prospects")).toEqual(
        expect.arrayContaining(["angle_approved_at", "angle_proposed_at"]),
      );
      const step = LEDGER_MIGRATIONS.find((m) => m.name === "learning-proposals")!;
      expect(() => step.up(db)).not.toThrow();
      expect(db.query("SELECT COUNT(*) AS n FROM learning_proposals").get()).toEqual({ n: 2 });
    });
    // The copied pending row is live on the compatibility surface.
    const ledger = new Ledger(dbPath);
    expect(ledger.icpProposals.list("pending").map((p) => p.id)).toEqual(["p2"]);
    expect(ledger.icpProposals.hasPendingDuplicate("series a ctos")).toBe(true);
    ledger.close();
  });

  it("v14 settles duplicate pending angle revisions (newest kept) before building the unique index", () => {
    new Ledger(dbPath).close();
    withRaw((db) => {
      db.exec("DROP INDEX idx_learning_proposals_pending_scope");
      const insert = db.prepare(
        `INSERT INTO learning_proposals(id, kind, scope_json, scope_key, proposed_json, evidence_json, evidence_summary, baseline_key, dedupe_key, status, created_at)
         VALUES (?, 'prospect_angle', '{"prospectId":7}', 'prospect:7', ?, '{"refs":[]}', '', '', ?, 'pending', ?)`,
      );
      insert.run("older", JSON.stringify({ hook: "a" }), "7:a", "2026-10-01T00:00:00Z");
      insert.run("newer", JSON.stringify({ hook: "b" }), "7:b", "2026-10-02T00:00:00Z");
      db.exec("PRAGMA user_version = 13");
    });
    new Ledger(dbPath).close();
    withRaw((db) => {
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      const rows = db
        .query("SELECT id, status FROM learning_proposals ORDER BY id")
        .all() as Array<{ id: string; status: string }>;
      expect(rows).toEqual([
        { id: "newer", status: "pending" },
        { id: "older", status: "stale" },
      ]);
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE name='idx_learning_proposals_pending_scope'")
          .get(),
      ).toBeTruthy();
    });
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

  it("reports the step's own error when the step already ended the transaction", () => {
    const migrations: LedgerMigration[] = [
      ...LEDGER_MIGRATIONS,
      {
        version: LEDGER_SCHEMA_VERSION + 1,
        name: "ends the transaction, then fails",
        up: (db) => {
          db.exec("ROLLBACK");
          throw new Error("the real cause");
        },
      },
    ];
    withRaw((db) => {
      expect(() => runLedgerMigrations(db, migrations)).toThrow("the real cause");
      expect(db.inTransaction).toBe(false);
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
