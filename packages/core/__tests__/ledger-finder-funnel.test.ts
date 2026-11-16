import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import type { FinderRunInput } from "../src/ledger-finder-funnel.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-finder-funnel-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

/** Local noon `daysAgo` days back: far from midnight in any zone. */
function localNoon(daysAgo: number): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 12);
}
const dayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const sqliteUtc = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

function run(over: Partial<FinderRunInput> = {}): FinderRunInput {
  const at = localNoon(0).toISOString();
  return {
    name: "hiring-signal",
    source: "find:hiring-signal",
    startedAt: at,
    finishedAt: at,
    candidates: 10,
    enqueued: 4,
    droppedDuplicate: 3,
    droppedEnrichment: 1,
    droppedRole: 1,
    droppedIcp: 1,
    costUsd: 0.25,
    halted: null,
    ...over,
  };
}

let seq = 0;
function queueRow(
  db: Database,
  row: {
    source: string;
    foundAt: Date;
    status: string;
    decidedBy?: string | null;
    decidedAt?: Date | null;
    decision?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, found_at, decided_by, decided_at, decision)
     VALUES('p', '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `k${++seq}`,
    row.source,
    row.status,
    sqliteUtc(row.foundAt),
    row.decidedBy ?? null,
    row.decidedAt ? row.decidedAt.toISOString() : null,
    row.decision ?? null,
  );
}

function withRaw(fn: (db: Database) => void): void {
  const db = new Database(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe("finder_runs", () => {
  it("inserts a run and reads it back since a time, with its local day", () => {
    const id = ledger.insertFinderRun(run({ halted: "max-cost cap (5)" }));
    ledger.insertFinderRun(run({ finishedAt: localNoon(3).toISOString(), name: "old" }));
    expect(id).toBeGreaterThan(0);
    const rows = ledger.listFinderRunsSince(localNoon(1).toISOString());
    expect(rows).toEqual([
      {
        id,
        name: "hiring-signal",
        source: "find:hiring-signal",
        started_at: run().startedAt,
        finished_at: run().finishedAt,
        day: dayOf(localNoon(0)),
        candidates: 10,
        enqueued: 4,
        dropped_dup: 3,
        dropped_enrich: 1,
        dropped_role: 1,
        dropped_icp: 1,
        cost_usd: 0.25,
        halted: "max-cost cap (5)",
      },
    ]);
    expect(ledger.listFinderRunsSince(localNoon(5).toISOString()).map((r) => r.name)).toEqual([
      "old",
      "hiring-signal",
    ]);
  });
});

describe("queue funnel", () => {
  it("counts rows per found day and source by status and who decided", () => {
    const today = localNoon(0);
    const yesterday = localNoon(1);
    withRaw((db) => {
      queueRow(db, { source: "find:a", foundAt: today, status: "pending" });
      queueRow(db, { source: "find:a", foundAt: today, status: "approved", decidedBy: "human" });
      queueRow(db, { source: "find:a", foundAt: today, status: "sent", decidedBy: "human_bulk" });
      queueRow(db, { source: "find:a", foundAt: today, status: "rejected", decidedBy: "human" });
      queueRow(db, { source: "find:a", foundAt: today, status: "rejected", decidedBy: "machine" });
      // Sent without a recorded human decision: sent, not approved.
      queueRow(db, { source: "find:a", foundAt: today, status: "sent", decidedBy: null });
      queueRow(db, { source: "find:b", foundAt: yesterday, status: "pending" });
      queueRow(db, { source: "find:a", foundAt: localNoon(9), status: "pending" });
    });
    expect(ledger.queueFunnelSince(localNoon(2).toISOString())).toEqual([
      {
        day: dayOf(yesterday),
        source: "find:b",
        queued: 1,
        autoRejected: 0,
        approved: 0,
        rejected: 0,
        sent: 0,
        pending: 1,
      },
      {
        day: dayOf(today),
        source: "find:a",
        queued: 5,
        autoRejected: 1,
        approved: 2,
        rejected: 1,
        sent: 2,
        pending: 1,
      },
    ]);
  });

  it("counts human approvals on the day they were made, whenever the row was found", () => {
    const today = localNoon(0);
    withRaw((db) => {
      const old = localNoon(6);
      queueRow(db, {
        source: "s",
        foundAt: old,
        status: "approved",
        decidedBy: "human",
        decidedAt: today,
      });
      queueRow(db, {
        source: "s",
        foundAt: old,
        status: "sent",
        decidedBy: "human_bulk",
        decidedAt: today,
      });
      queueRow(db, {
        source: "s",
        foundAt: old,
        status: "rejected",
        decidedBy: "human",
        decidedAt: today,
      });
      queueRow(db, {
        source: "s",
        foundAt: old,
        status: "rejected",
        decidedBy: "machine",
        decidedAt: today,
      });
      queueRow(db, {
        source: "s",
        foundAt: old,
        status: "approved",
        decidedBy: "human",
        decidedAt: localNoon(1),
      });
      queueRow(db, {
        source: "s",
        foundAt: old,
        status: "approved",
        decidedBy: "human",
        decidedAt: localNoon(4),
      });
    });
    expect(ledger.approvedByDecisionDaySince(localNoon(2).toISOString())).toEqual([
      { day: dayOf(localNoon(1)), approved: 1 },
      { day: dayOf(today), approved: 2 },
    ]);
  });

  it("keeps an approval that later expired on its day, and leaves out one reopened to pending", () => {
    const yesterday = localNoon(1);
    withRaw((db) => {
      const base = { source: "s", foundAt: localNoon(3), decidedBy: "human", decidedAt: yesterday };
      queueRow(db, { ...base, status: "approved", decision: "approve" });
      // A reply arrived first and expired the approved row; the decision stays.
      queueRow(db, { ...base, status: "expired", decision: "approve" });
      // Reopened: back to pending, the old decision columns left in place.
      queueRow(db, { ...base, status: "pending", decision: "approve" });
      // Expired without ever being approved.
      queueRow(db, { ...base, status: "expired", decidedBy: null, decidedAt: null });
    });
    expect(ledger.approvedByDecisionDaySince(localNoon(2).toISOString())).toEqual([
      { day: dayOf(yesterday), approved: 2 },
    ]);
  });
});
