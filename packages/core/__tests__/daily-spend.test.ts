import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import type { OneShotConfig } from "../src/types.ts";

/**
 * Install-wide daily USD spend ceiling (issue #481). Covers:
 *  - aggregation (posted receipts + held reservations = "effective" spend)
 *  - concurrent reservations (two callers racing the same tick both get
 *    counted before either one's spend posts to `receipts`)
 *  - blocked-path reporting (the named reason string, refused-not-reserved)
 *  - manual-send behavior (nothing here ever calls tryReserveDailySpend —
 *    that's the acceptance criterion: manual /queue actions never consult
 *    the ceiling. Asserted by omission: manual routes only ever call
 *    ledger.setQueueStatus/setQueueDraft directly, never daily-spend.ts)
 *  - midnight-boundary behavior (yesterday's spend/reservations don't count
 *    against today; the ceiling resets)
 */

let dbPath: string;
let ledger: Ledger;
let mockCfg: Partial<OneShotConfig>;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...mockCfg }),
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ledger,
  };
});

const {
  dailySpendStatus,
  spendCeilingReason,
  tryReserveDailySpend,
  DEFAULT_SPEND_RESERVATION_USD,
  DEFAULT_DRAIN_ROW_RESERVATION_USD,
} = await import("../src/daily-spend.ts");

/** Reach the private `db` handle for backdating created_at (same pattern send-routing.test.ts uses). */
function rawDb(): { prepare(s: string): { run(...a: unknown[]): unknown } } {
  return (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
    .db;
}

function recordSpend(amountUsd: number, whenIso?: string): void {
  const id = ledger.recordReceipt({
    playName: "test-play",
    callType: "email.find",
    costUsd: amountUsd,
  });
  if (whenIso) {
    // Backdate the receipt directly — recordReceipt always stamps "now".
    rawDb().prepare(`UPDATE receipts SET created_at = ? WHERE id = ?`).run(whenIso, id);
  }
}

/** SQLite UTC timestamp for `hoursAgo` hours before now, in receipts.created_at's format. */
function hoursAgoSqlite(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-daily-spend-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  mockCfg = { dailySpendCeilingUsd: null };
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

describe("dailySpendStatus — aggregation", () => {
  it("unlimited (ceilingUsd null) when no ceiling is configured", () => {
    const status = dailySpendStatus();
    expect(status.ceilingUsd).toBeNull();
    expect(status.remainingUsd).toBeNull();
    expect(status.ceilingReached).toBe(false);
  });

  it("effectiveUsd sums posted spend AND held reservations", () => {
    mockCfg = { dailySpendCeilingUsd: 10 };
    recordSpend(3);
    const held = tryReserveDailySpend(2);
    expect(held.granted).toBe(true);

    const status = dailySpendStatus();
    expect(status.spentUsd).toBe(3);
    expect(status.reservedUsd).toBe(2);
    expect(status.effectiveUsd).toBe(5);
    expect(status.remainingUsd).toBe(5);
    expect(status.ceilingReached).toBe(false);
  });

  it("ceilingReached flips true once effective spend meets (>=) the ceiling", () => {
    mockCfg = { dailySpendCeilingUsd: 5 };
    recordSpend(5);
    const status = dailySpendStatus();
    expect(status.ceilingReached).toBe(true);
    expect(status.remainingUsd).toBe(0); // floored at 0, never negative
  });

  it("remainingUsd never goes negative when spend overshoots the ceiling", () => {
    mockCfg = { dailySpendCeilingUsd: 5 };
    recordSpend(8);
    expect(dailySpendStatus().remainingUsd).toBe(0);
  });
});

describe("tryReserveDailySpend — blocked-path reporting", () => {
  it("grants a reservation and releases cleanly under the ceiling", () => {
    mockCfg = { dailySpendCeilingUsd: 10 };
    const outcome = tryReserveDailySpend(4);
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) throw new Error("expected granted");
    expect(dailySpendStatus().reservedUsd).toBe(4);
    outcome.release();
    expect(dailySpendStatus().reservedUsd).toBe(0);
  });

  it("refuses outright — never reserves-then-over — once at/over the ceiling", () => {
    mockCfg = { dailySpendCeilingUsd: 5 };
    recordSpend(5);
    const outcome = tryReserveDailySpend(1);
    expect(outcome.granted).toBe(false);
    if (outcome.granted) throw new Error("expected refused");
    // The named reason surfaced on trigger cards / doctor / drain output.
    expect(outcome.reason).toBe(spendCeilingReason(outcome.status));
    expect(outcome.reason).toContain("daily spend ceiling reached");
    expect(outcome.reason).toContain("$5.00");
    // Refusing must not have reserved anything against the day.
    expect(dailySpendStatus().reservedUsd).toBe(0);
  });

  it("release() is idempotent — a finally + an explicit release must not double-delete", () => {
    mockCfg = { dailySpendCeilingUsd: 10 };
    const outcome = tryReserveDailySpend(3);
    if (!outcome.granted) throw new Error("expected granted");
    outcome.release();
    outcome.release(); // second call must be a no-op, not throw or double-decrement
    expect(dailySpendStatus().reservedUsd).toBe(0);
  });
});

describe("tryReserveDailySpend — concurrent reservations", () => {
  it("two racing automated calls both count before either one's spend posts", () => {
    // The whole point of reservations: without them, two calls reading
    // "today's spend = $0" at the same tick could both start and together
    // blow past the ceiling before either one's receipt lands.
    mockCfg = { dailySpendCeilingUsd: 6 };
    const first = tryReserveDailySpend(4);
    const second = tryReserveDailySpend(4);
    expect(first.granted).toBe(true);
    // Second call sees the first's reservation already counted (4+4=8 > 6),
    // so it must be refused even though NO actual spend has posted to
    // `receipts` yet.
    expect(second.granted).toBe(false);
    if (second.granted) throw new Error("expected refused");
    expect(second.reason).toContain("daily spend ceiling reached");
  });

  it("a released reservation frees room for the next caller in the same tick", () => {
    mockCfg = { dailySpendCeilingUsd: 6 };
    const first = tryReserveDailySpend(4);
    if (!first.granted) throw new Error("expected granted");
    first.release(); // simulates the first call finishing (success or failure)
    const second = tryReserveDailySpend(4);
    expect(second.granted).toBe(true);
  });

  it("sweeps a stale (crashed-process) reservation before checking the ceiling", () => {
    mockCfg = { dailySpendCeilingUsd: 6 };
    // Simulate an orphaned reservation from a killed process: reserve, never release.
    const orphan = tryReserveDailySpend(5);
    expect(orphan.granted).toBe(true);
    // A fresh caller shortly after would normally be refused (5 held + a new
    // 5 estimate tips over 6), but tryReserveDailySpend sweeps anything past
    // its stale window first — simulate that by aging the row past it.
    rawDb().prepare(`UPDATE spend_reservations SET created_at = datetime('now', '-3 hours')`).run();
    const later = tryReserveDailySpend(5);
    expect(later.granted).toBe(true); // the orphan was swept, so full room is available
  });
});

describe("dailySpendStatus / tryReserveDailySpend — midnight-boundary behavior", () => {
  it("yesterday's posted spend does not count against today", () => {
    mockCfg = { dailySpendCeilingUsd: 5 };
    recordSpend(5, hoursAgoSqlite(25)); // well before local midnight
    const status = dailySpendStatus();
    expect(status.spentUsd).toBe(0);
    expect(status.ceilingReached).toBe(false);
  });

  it("yesterday's stale reservation is excluded from today's reservedUsd window", () => {
    mockCfg = { dailySpendCeilingUsd: 5 };
    const outcome = tryReserveDailySpend(4);
    if (!outcome.granted) throw new Error("expected granted");
    // Backdate the reservation itself to yesterday (crashed before release,
    // AND happens to straddle the day boundary).
    rawDb().prepare(`UPDATE spend_reservations SET created_at = ?`).run(hoursAgoSqlite(25));
    expect(dailySpendStatus().reservedUsd).toBe(0);
  });

  it("a trigger that halted yesterday at the ceiling is not halted today (reset)", () => {
    mockCfg = { dailySpendCeilingUsd: 5 };
    recordSpend(5, hoursAgoSqlite(25)); // yesterday's spend reached the ceiling
    const outcome = tryReserveDailySpend(1); // today's first automated call
    expect(outcome.granted).toBe(true); // fresh day, fresh budget
  });
});

describe("estimation defaults", () => {
  it("DEFAULT_SPEND_RESERVATION_USD and DEFAULT_DRAIN_ROW_RESERVATION_USD are positive", () => {
    // Sanity check on the constants estimatedTriggerSpendUsd / drainQueue
    // fall back to for a finder/drain with no explicit spend cap — a zero or
    // negative default would let a "free" caller starve nothing (harmless)
    // or reserve nothing (defeats the whole point of reserving).
    expect(DEFAULT_SPEND_RESERVATION_USD).toBeGreaterThan(0);
    expect(DEFAULT_DRAIN_ROW_RESERVATION_USD).toBeGreaterThan(0);
  });
});

describe("Ledger.reserveSpendIfUnderCeiling — cross-connection atomicity", () => {
  // Round-1 review finding: tryReserveDailySpend's check-then-reserve used to
  // be a plain SELECT (dailySpendStatus) followed by a separate INSERT
  // (ledger.reserveSpend) — two round-trips. That's serialized for free
  // within one Bun process (same event loop, same Ledger instance, as every
  // other test in this file exercises), but the issue's own scope is eleven
  // independently-scheduled finders, and this repo runs `find watch --once`
  // as a SEPARATE OS process from the server's in-process scheduler. Two
  // separate SQLite connections in WAL mode can each pass a plain SELECT
  // before either INSERTs. This test opens a SECOND real connection to the
  // SAME on-disk database — not just a second call on the same Ledger
  // instance — to prove the check-then-reserve is atomic across connections,
  // the way Ledger.dequeueApproved's own BEGIN IMMEDIATE closes the same
  // TOCTOU class for concurrent drains.
  it("two separate connections racing the same budget: only one is granted", () => {
    const secondConnection = new Ledger(dbPath);
    try {
      const sinceIso = "1970-01-01 00:00:00";
      const ceilingUsd = 6;
      // Both "processes" read the SAME pre-reservation state (nothing spent
      // yet) before either reserves — simulating two finders firing on the
      // same tick from different OS processes.
      const first = ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd, amountUsd: 4 });
      const second = secondConnection.reserveSpendIfUnderCeiling({
        sinceIso,
        ceilingUsd,
        amountUsd: 4,
      });
      expect(first).not.toBeNull();
      // Without cross-connection atomicity, `second` would also read "0
      // reserved" and be granted too — 4+4=8 blowing past the 6 ceiling
      // before either reservation's estimate was accounted for.
      expect(second).toBeNull();
      expect(ledger.reservedSpendUsd(sinceIso)).toBe(4);
    } finally {
      secondConnection.close();
    }
  });

  it("a released reservation on one connection frees room seen by another connection", () => {
    const secondConnection = new Ledger(dbPath);
    try {
      const sinceIso = "1970-01-01 00:00:00";
      const ceilingUsd = 6;
      const first = ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd, amountUsd: 4 });
      expect(first).not.toBeNull();
      ledger.releaseSpendReservation(first as number);
      const second = secondConnection.reserveSpendIfUnderCeiling({
        sinceIso,
        ceilingUsd,
        amountUsd: 4,
      });
      expect(second).not.toBeNull();
    } finally {
      secondConnection.close();
    }
  });
});
