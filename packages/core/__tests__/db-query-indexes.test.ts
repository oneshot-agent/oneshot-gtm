import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { LEDGER_MIGRATIONS, runLedgerMigrations } from "../src/ledger-schema.ts";
import { SharedDb } from "../src/shared-db.ts";
import { SharedPeople } from "../src/shared-people.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "query-indexes-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function raw(store: Ledger | SharedDb): Database {
  return (store as unknown as { db: Database }).db;
}

function plan(db: Database, sql: string, ...args: (string | number)[]): string {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
    .map((row) => row.detail)
    .join("\n");
}

it("indexes alias expansion on reopening an existing shared database without changing touches", () => {
  const path = join(root, "shared.sqlite");
  const people = new SharedPeople(path);
  const person = people.resolve({ email: "old@example.test" });
  people.resolve({ email: "new@example.test" }, person.id);
  people.close();
  const legacy = new Database(path);
  legacy.exec("DROP INDEX IF EXISTS person_aliases_person");
  legacy.close();
  new SharedPeople(path).close();
  new SharedPeople(path).close();
  const shared = new SharedDb(path);
  try {
    shared.recordTouch({ email: "old@example.test", workspace: "beta", playName: "intro" });
    const query = vi.spyOn(raw(shared), "query");
    expect(shared.recentTouchElsewhere(" NEW@example.test ", "alpha")?.workspace).toBe("beta");
    expect(shared.touchesFor("new@example.test")).toEqual(shared.touchesFor("old@example.test"));
    const sql = query.mock.calls.find(([sql]) => sql.includes("SELECT substr(alias,7)"))![0];
    const details = plan(raw(shared), sql, "email:new@example.test");
    expect(details).toContain("SEARCH person_aliases USING INDEX person_aliases_person");
    expect(details).not.toContain("SCAN person_aliases");
  } finally {
    shared.close();
  }
});

function existingLedger(): Ledger {
  const path = join(root, "ledger.sqlite");
  const db = new Database(path);
  runLedgerMigrations(
    db,
    LEDGER_MIGRATIONS.filter((step) => step.version <= 17),
  );
  db.exec("DROP INDEX IF EXISTS idx_queue_status_found; DROP INDEX IF EXISTS idx_queue_prospect");
  db.close();
  new Ledger(path).close();
  return new Ledger(path);
}

function seedQueue(ledger: Ledger): number[] {
  return ["2026-10-02", "2026-10-01", "2026-10-02"].map((date, i) => {
    const id = ledger.enqueueTarget({
      playName: "intro",
      payload: { email: `person${i}@example.test` },
      dedupeKey: `person${i}`,
      source: "test",
      initialStatus: "rejected",
    })!;
    raw(ledger).query("UPDATE target_queue SET found_at = ? WHERE id = ?").run(date, id);
    return id;
  });
}

it("seeks status pages in date order after upgrading a ledger, without a temporary sort", () => {
  const ledger = existingLedger();
  try {
    const ids = seedQueue(ledger);
    const query = vi.spyOn(raw(ledger), "query");
    expect(ledger.listQueue({ status: "rejected", limit: 3 }).map((row) => row.id)).toEqual([
      ids[0],
      ids[2],
      ids[1],
    ]);
    const sql = query.mock.calls[0]![0];
    const details = plan(raw(ledger), sql, "rejected", 3);
    expect(details).toContain("SEARCH target_queue USING INDEX idx_queue_status_found");
    expect(details).not.toMatch(/SCAN target_queue|TEMP B-TREE/);
  } finally {
    ledger.close();
  }
});

it("seeks the latest row for a prospect after upgrading, preserving the id tiebreak", () => {
  const ledger = existingLedger();
  try {
    const ids = seedQueue(ledger);
    const prospect = ledger.upsertProspect({ email: "person@example.test" });
    for (const id of ids) ledger.setQueueProspectId(id, prospect);
    const query = vi.spyOn(raw(ledger), "query");
    expect(ledger.getQueueRowForProspect(prospect)?.id).toBe(ids[2]);
    const sql = query.mock.calls[0]![0];
    const details = plan(raw(ledger), sql, prospect);
    expect(details).toContain("SEARCH target_queue USING INDEX idx_queue_prospect");
    expect(details).not.toContain("SCAN target_queue");
    expect(ledger.getQueueRowForProspect(prospect + 1)).toBeNull();
  } finally {
    ledger.close();
  }
});

it("drains equal-timestamp rows in FIFO order with the status/date index present", () => {
  const ledger = existingLedger();
  try {
    const ids = seedQueue(ledger);
    for (const id of ids) ledger.setQueueStatus({ id, status: "approved" });
    expect(ledger.dequeueApproved({ playName: "intro", limit: 2 }).map((row) => row.id)).toEqual([
      ids[1],
      ids[0],
    ]);
    expect(ledger.dequeueApproved({ playName: "intro", limit: 2 }).map((row) => row.id)).toEqual([
      ids[2],
    ]);
  } finally {
    ledger.close();
  }
});

it("avoids per-touch schema probes while seeing identities added after SharedDb construction", () => {
  const path = join(root, "shared.sqlite");
  const shared = new SharedDb(path);
  try {
    const query = vi.spyOn(raw(shared), "query");
    shared.recordTouch({ email: "old@example.test", workspace: "beta", playName: "intro" });
    expect(shared.recentTouchElsewhere(" OLD@example.test ", "alpha")?.workspace).toBe("beta");
    expect(shared.recentTouchElsewhere("new@example.test", "alpha")).toBeNull();
    const people = new SharedPeople(path);
    try {
      const person = people.resolve({ email: "old@example.test" });
      people.resolve({ email: "new@example.test" }, person.id);
    } finally {
      people.close();
    }
    expect(shared.recentTouchElsewhere("new@example.test", "alpha")?.workspace).toBe("beta");
    expect(query.mock.calls.filter(([sql]) => /sqlite_master/i.test(sql))).toEqual([]);
  } finally {
    shared.close();
  }
});
