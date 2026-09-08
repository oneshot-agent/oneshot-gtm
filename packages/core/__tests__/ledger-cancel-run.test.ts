import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function newRun(playName = "show-hn"): number {
  return ledger.createRun({ playName, dryRun: false, targets: [{ email: "a@x.dev" }] }).runId;
}

describe("Ledger.cancelRun", () => {
  it("flips a running row to the terminal cancelled state with its reason", () => {
    const runId = newRun();
    const res = ledger.cancelRun({ runId, reason: "cancelled by user" });
    expect(res).toEqual({ cancelled: true, status: "cancelled" });
    const run = ledger.getRun(runId)!;
    expect(run.status).toBe("cancelled");
    expect(run.cancelReason).toBe("cancelled by user");
    expect(run.completedAt).not.toBeNull();
  });

  it("records what actually sent before the abort", () => {
    const runId = newRun();
    ledger.cancelRun({ runId, reason: "client disconnected", sentEmails: ["a@x.dev"] });
    expect(ledger.getRun(runId)?.prospectEmails).toEqual(["a@x.dev"]);
  });

  it("is a no-op — not an error — against a run that already finished", () => {
    // Acceptance (d): the stop button races the run's own completion, and
    // losing that race must not corrupt the row or throw.
    const runId = newRun();
    ledger.markRunComplete({ runId, status: "done", sentEmails: ["a@x.dev"] });
    const completedAt = ledger.getRun(runId)?.completedAt;
    const res = ledger.cancelRun({ runId, reason: "cancelled by user" });
    expect(res).toEqual({ cancelled: false, status: "done" });
    const run = ledger.getRun(runId)!;
    expect(run.status).toBe("done");
    expect(run.cancelReason).toBeNull();
    expect(run.completedAt).toBe(completedAt);
  });

  it("only the first of two concurrent cancels reports having done it", () => {
    const runId = newRun();
    expect(ledger.cancelRun({ runId, reason: "route" }).cancelled).toBe(true);
    const second = ledger.cancelRun({ runId, reason: "sse handler" });
    expect(second).toEqual({ cancelled: false, status: "cancelled" });
    // The first reason is the one that survives.
    expect(ledger.getRun(runId)?.cancelReason).toBe("route");
  });

  it("still records the handler's sent emails when the route flipped the row first", () => {
    // The two writers land in either order; the emails belong on the record
    // regardless of which one won the CAS.
    const runId = newRun();
    ledger.cancelRun({ runId, reason: "cancelled by user" });
    ledger.cancelRun({ runId, reason: "show-hn send: cancelled by user", sentEmails: ["a@x.dev"] });
    expect(ledger.getRun(runId)?.prospectEmails).toEqual(["a@x.dev"]);
    expect(ledger.getRun(runId)?.cancelReason).toBe("cancelled by user");
  });

  it("cannot be resurrected as 'done' by a late markRunComplete", () => {
    const runId = newRun();
    ledger.cancelRun({ runId, reason: "cancelled by user" });
    ledger.markRunComplete({ runId, status: "done", sentEmails: [] });
    expect(ledger.getRun(runId)?.status).toBe("cancelled");
  });

  it("reports a null status for a run that does not exist", () => {
    expect(ledger.cancelRun({ runId: 987654, reason: "x" })).toEqual({
      cancelled: false,
      status: null,
    });
  });

  it("leaves a cancelled row out of the running list and findable by status", () => {
    const cancelled = newRun("show-hn");
    const live = newRun("post-funding");
    ledger.cancelRun({ runId: cancelled, reason: "cancelled by user" });
    expect(ledger.listRuns({ status: "running" }).map((r) => r.id)).toEqual([live]);
    expect(ledger.listRuns({ status: "cancelled" }).map((r) => r.id)).toEqual([cancelled]);
  });
});

describe("sweepStaleRuns vs cancelled runs", () => {
  it("leaves a cancelled row alone on cold boot (acceptance b)", () => {
    const cancelled = newRun("show-hn");
    ledger.cancelRun({ runId: cancelled, reason: "cancelled by user" });
    const completedAt = ledger.getRun(cancelled)?.completedAt;

    const swept = ledger.sweepStaleRuns({ now: new Date(), maxAgeMs: 0 });
    expect(swept).toHaveLength(0);
    const run = ledger.getRun(cancelled)!;
    expect(run.status).toBe("cancelled");
    expect(run.cancelReason).toBe("cancelled by user");
    expect(run.completedAt).toBe(completedAt);
  });

  it("still reconciles a run orphaned by process exit (acceptance c)", () => {
    // The row the dead process left behind: 'running', no controller anywhere.
    const orphan = newRun("post-funding");
    const cancelled = newRun("show-hn");
    ledger.cancelRun({ runId: cancelled, reason: "cancelled by user" });

    const swept = ledger.sweepStaleRuns({ now: new Date(), maxAgeMs: 0 });
    expect(swept.map((s) => s.id)).toEqual([orphan]);
    expect(ledger.getRun(orphan)?.status).toBe("interrupted");
    expect(ledger.getRun(cancelled)?.status).toBe("cancelled");
  });

  it("does not report a row it did not actually write", () => {
    // The sweep's SELECT and UPDATE are separate statements; a cancel landing
    // between them must not produce a phantom 'swept' log line.
    const runId = newRun();
    const rows = ledger.listRuns({ status: "running" });
    expect(rows.map((r) => r.id)).toEqual([runId]);
    ledger.cancelRun({ runId, reason: "cancelled by user" });
    expect(ledger.sweepStaleRuns({ now: new Date(), maxAgeMs: 0 })).toHaveLength(0);
  });
});

describe("runs.status CHECK widening", () => {
  it("admits 'cancelled' on a database created before the state existed", async () => {
    // Dynamic import: `bun:sqlite` is only resolvable at runtime here, as the
    // other ledger tests do it.
    const { Database } = await import("bun:sqlite");
    // A pre-v24 install: the CHECK constraint physically rejects the new
    // state, and SQLite cannot ALTER it — so the open path has to rebuild.
    ledger.close();
    const legacyPath = join(
      tmpdir(),
      `oneshot-gtm-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const raw = new Database(legacyPath);
    raw.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','done','interrupted')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        target_count INTEGER NOT NULL,
        drafted_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        targets_json TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        prospect_emails_json TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO runs (id, play_name, dry_run, status, started_at, target_count, targets_json,
                        events_json, prospect_emails_json)
        VALUES (5, 'show-hn', 0, 'running', '2026-08-01T00:00:00.000Z', 1, '[{"email":"a@x.dev"}]',
                '[{"kind":"draft"}]', '["a@x.dev"]');
    `);
    raw.close();

    const migrated = new Ledger(legacyPath);
    try {
      // The pre-existing row survives the rebuild intact, id included.
      const before = migrated.getRun(5)!;
      expect(before.playName).toBe("show-hn");
      expect(before.status).toBe("running");
      expect(before.events).toHaveLength(1);
      expect(before.prospectEmails).toEqual(["a@x.dev"]);
      expect(before.cancelReason).toBeNull();

      expect(migrated.cancelRun({ runId: 5, reason: "cancelled by user" }).cancelled).toBe(true);
      expect(migrated.getRun(5)?.status).toBe("cancelled");
      // The status index came back with the rebuilt table.
      expect(migrated.listRuns({ status: "cancelled" }).map((r) => r.id)).toEqual([5]);
      // AUTOINCREMENT still hands out ids above the migrated row.
      expect(
        migrated.createRun({ playName: "post-funding", dryRun: true, targets: [{}] }).runId,
      ).toBeGreaterThan(5);
    } finally {
      migrated.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${legacyPath}${suffix}`);
        } catch {
          // ignore
        }
      }
    }
  });

  it("is idempotent — re-opening a migrated database does not rebuild or lose rows", () => {
    const runId = newRun();
    ledger.cancelRun({ runId, reason: "cancelled by user" });
    ledger.close();
    const reopened = new Ledger(dbPath);
    ledger = reopened; // so afterEach closes the live handle
    expect(reopened.getRun(runId)?.status).toBe("cancelled");
    expect(reopened.getRun(runId)?.cancelReason).toBe("cancelled by user");
  });
});
