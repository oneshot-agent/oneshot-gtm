import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { migrateLedgerSchema } from "../src/ledger-schema.ts";

// Timestamp columns hold either SQLite form ("YYYY-MM-DD HH:MM:SS") or ISO
// ("…T…Z"). Since ' ' < 'T', a string comparison across the two is wrong for
// every row on the bound's own calendar day. These pin the boundary day: a row
// stamped in one form must be windowed correctly by a bound in the other.

let dbPath: string;
let ledger: Ledger;
let db: Database;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-ts-formats-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

const DAY = "2026-08-10";
const ISO_NOON = `${DAY}T12:00:00.000Z`;

/** SQLite-form, the shape a `datetime('now')` DEFAULT writes. */
function sqliteAt(isoMs: number): string {
  return new Date(isoMs).toISOString().slice(0, 19).replace("T", " ");
}

describe("receipts windows (created_at is SQLite form)", () => {
  beforeEach(() => {
    const insert = db.prepare(
      "INSERT INTO receipts(play_name, call_type, cost_usd, created_at) VALUES('p', 'web.read', ?, ?)",
    );
    insert.run(1, `${DAY} 10:00:00`); // before noon: outside
    insert.run(2, `${DAY} 14:00:00`); // after noon: inside
  });

  it("listReceipts, countReceipts, totalSpendUsd and spendByPlay honour an ISO bound", () => {
    expect(ledger.listReceipts({ sinceIso: ISO_NOON }).map((r) => r.cost_usd)).toEqual([2]);
    expect(ledger.countReceipts({ sinceIso: ISO_NOON })).toBe(1);
    expect(ledger.totalSpendUsd({ sinceIso: ISO_NOON })).toBe(2);
    const byPlay = ledger.spendByPlay({ sinceIso: ISO_NOON });
    expect(byPlay).toHaveLength(1);
    expect(byPlay[0]).toMatchObject({ play_name: "p", calls: 1 });
  });

  it("still accepts a SQLite-form bound", () => {
    expect(ledger.countReceipts({ sinceIso: `${DAY} 12:00:00` })).toBe(1);
  });
});

describe("eventsByPlay", () => {
  beforeEach(() => {
    db.exec("INSERT INTO prospects(id, email) VALUES (1, 'a@x.com')");
    const insert = db.prepare(
      "INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, created_at, bounced_at) VALUES (1, 'p', ?, 'email', ?, ?, ?)",
    );
    insert.run(0, "sent", `${DAY} 10:00:00`, null);
    insert.run(1, "sent", `${DAY} 14:00:00`, null);
    // Detected (created_at) late, but bounced (provider ISO) before noon.
    insert.run(2, "bounced", `${DAY} 18:00:00`, `${DAY}T11:00:00.000Z`);
    // Bounced after noon.
    insert.run(3, "bounced", `${DAY} 18:00:00`, `${DAY}T13:00:00.000Z`);
  });

  it("windows created_at by an ISO bound", () => {
    const rows = ledger.eventsByPlay({ sinceIso: ISO_NOON });
    expect(rows[0]).toMatchObject({ play_name: "p", sent: 1 });
  });

  it("windows ISO bounced_at by a non-midnight bound in occurrence mode", () => {
    const rows = ledger.eventsByPlay({
      sinceIso: `${DAY} 12:00:00`,
      untilIso: `${DAY} 23:00:00`,
      occurrenceWindow: true,
    });
    expect(rows[0]).toMatchObject({ play_name: "p", bounced: 1 });
  });
});

describe("outcomes windows (recorded_at is SQLite form)", () => {
  it("countOutcomes and outcomesByPlay honour an ISO bound", () => {
    db.exec("INSERT INTO prospects(id, email) VALUES (1, 'a@x.com')");
    const insert = db.prepare(
      "INSERT INTO deal_outcomes(prospect_id, play_name, outcome, recorded_at) VALUES (1, 'p', 'meeting_booked', ?)",
    );
    insert.run(`${DAY} 10:00:00`);
    insert.run(`${DAY} 14:00:00`);
    expect(ledger.countOutcomes({ sinceIso: ISO_NOON })).toBe(1);
    expect(ledger.outcomesByPlay({ sinceIso: ISO_NOON })[0]).toMatchObject({ meetings: 1 });
  });
});

describe("age sweeps against SQLite-form columns", () => {
  const HOUR = 3600 * 1000;

  it("sweepStalePendingResolution keeps a row younger than the cutoff on the same day", () => {
    const maxAgeMs = 48 * HOUR;
    const insert = db.prepare(
      "INSERT INTO pending_resolution(play_name, dedupe_key, source, raw_json, first_seen_at) VALUES ('p', ?, 's', '{}', ?)",
    );
    insert.run("young", sqliteAt(Date.now() - maxAgeMs + 60_000));
    insert.run("old", sqliteAt(Date.now() - maxAgeMs - HOUR));
    expect(ledger.sweepStalePendingResolution(maxAgeMs)).toBe(1);
    const left = db.query("SELECT dedupe_key FROM pending_resolution").all() as Array<{
      dedupe_key: string;
    }>;
    expect(left.map((r) => r.dedupe_key)).toEqual(["young"]);
  });

  it("expirePendingOlderThan keeps a row younger than the cutoff on the same day", () => {
    const insert = db.prepare(
      "INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, found_at) VALUES ('p', '{}', ?, 's', ?)",
    );
    insert.run("young", sqliteAt(Date.now() - 24 * HOUR + 60_000));
    insert.run("old", sqliteAt(Date.now() - 24 * HOUR - HOUR));
    expect(ledger.expirePendingOlderThan(1)).toBe(1);
    const pending = db
      .query("SELECT dedupe_key FROM target_queue WHERE status = 'pending'")
      .all() as Array<{ dedupe_key: string }>;
    expect(pending.map((r) => r.dedupe_key)).toEqual(["young"]);
  });
});

describe("listPendingOutcomeMeetings (ends_at carries the event's offset)", () => {
  /** RFC 3339 at UTC-7, the shape Google returns for a timed event. */
  function pacific(ms: number): string {
    return `${new Date(ms - 7 * 3600 * 1000).toISOString().slice(0, 19)}-07:00`;
  }

  it("returns a meeting that ended two hours ago and holds one ending in ten minutes", () => {
    const now = Date.now();
    for (const [eventId, endMs] of [
      ["ended", now - 2 * 3600 * 1000],
      ["upcoming", now + 10 * 60 * 1000],
    ] as const) {
      ledger.upsertMeeting({
        calendarId: "primary",
        eventId,
        status: "confirmed",
        summary: eventId,
        allDay: false,
        startsAt: pacific(endMs - 30 * 60 * 1000),
        endsAt: pacific(endMs),
        eventUpdatedAt: new Date(now).toISOString(),
        attendeesFingerprint: "pat@acme.com",
        prospectId: 7,
        matchStatus: "exact",
      });
    }
    expect(ledger.listPendingOutcomeMeetings().map((m) => m.event_id)).toEqual(["ended"]);
  });
});

describe("listColdProspects", () => {
  it("picks the latest event across formats and returns it as ISO", () => {
    const day = new Date(Date.now() - 75 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    db.exec("INSERT INTO prospects(id, name, email) VALUES (1, 'Ada', 'ada@x.com')");
    // A SQLite-form send at 14:00 is later than an ISO reply at 10:00 the same
    // day; as strings the ISO value sorts higher.
    db.prepare(
      "INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, created_at) VALUES (1, 'p', 0, 'email', 'sent', ?)",
    ).run(`${day} 14:00:00`);
    db.prepare(
      "INSERT INTO inbox_replies(id, thread_key, prospect_id, from_email, body, received_at) VALUES ('r1', 't1', 1, 'ada@x.com', 'thanks', ?)",
    ).run(`${day}T10:00:00.000Z`);

    const cold = ledger.listColdProspects({ minDaysSinceLastEvent: 60, maxDaysSinceLastEvent: 90 });
    expect(cold.map((p) => p.id)).toEqual([1]);
    expect(cold[0]!.last_event_at).toBe(`${day}T14:00:00.000Z`);
  });
});

describe("decided_at normalization", () => {
  it("rewrites SQLite-form decided_at to ISO and is idempotent", () => {
    db.exec(
      `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, decided_at, decision, decided_by)
       VALUES ('p', '{}', 'k', 's', 'rejected', '${DAY} 09:30:00', 'auto_reject', 'machine')`,
    );
    migrateLedgerSchema(db);
    migrateLedgerSchema(db);
    const row = db.query("SELECT decided_at FROM target_queue").get() as { decided_at: string };
    expect(row.decided_at).toBe(`${DAY}T09:30:00.000Z`);
  });

  it("backfills a legacy auto-reject from found_at in ISO form", () => {
    db.exec(
      `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, notes, found_at)
       VALUES ('p', '{}', 'k2', 's', 'rejected', 'auto: off-icp', '${DAY} 08:00:00')`,
    );
    migrateLedgerSchema(db);
    const row = db.query("SELECT decided_at FROM target_queue WHERE dedupe_key = 'k2'").get() as {
      decided_at: string;
    };
    expect(row.decided_at).toBe(`${DAY}T08:00:00.000Z`);
  });
});
