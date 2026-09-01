import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import type { ProspectPriority } from "../src/types.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-ledger-priority-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

const PRIORITY: ProspectPriority = {
  version: "heuristic-v1",
  total: 72,
  components: {
    personFit: 90,
    accountFit: 55,
    intentStrength: 80,
    timingFreshness: 60,
    signalConfidence: 65,
    contactability: 85,
  },
  reasons: ["title: CTO", "raised Seed $2.0M"],
  finder: "post-funding",
  scoredAt: "2026-09-01T12:00:00.000Z",
};

function enqueue(overrides: Record<string, unknown> = {}): number {
  return ledger.enqueueTarget({
    playName: "post-funding",
    payload: { name: "Ada", email: "ada@acme.dev" },
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:post-funding",
    ...overrides,
  })!;
}

describe("target_queue priority persistence", () => {
  it("round-trips a priority through enqueueTarget", () => {
    const id = enqueue({ priority: PRIORITY });
    const row = ledger.getQueueRow(id)!;
    expect(JSON.parse(row.priority_json!)).toEqual(PRIORITY);
  });

  it("persists null when no priority is given (legacy/manual path)", () => {
    const id = enqueue();
    expect(ledger.getQueueRow(id)!.priority_json).toBeNull();
  });

  it("keeps the dedupe-collision null return with a priority attached", () => {
    enqueue({ dedupeKey: "same", priority: PRIORITY });
    const second = ledger.enqueueTarget({
      playName: "post-funding",
      payload: {},
      dedupeKey: "same",
      source: "find:post-funding",
      priority: PRIORITY,
    });
    expect(second).toBeNull();
  });

  it("setQueuePriority writes and clears", () => {
    const id = enqueue();
    ledger.setQueuePriority(id, PRIORITY);
    expect(JSON.parse(ledger.getQueueRow(id)!.priority_json!)).toEqual(PRIORITY);
    ledger.setQueuePriority(id, null);
    expect(ledger.getQueueRow(id)!.priority_json).toBeNull();
  });

  it("a malformed priority_json never blocks queue listing", () => {
    const id = enqueue();
    const db = (ledger as unknown as { db: Database }).db;
    db.prepare(`UPDATE target_queue SET priority_json = ? WHERE id = ?`).run("{not json", id);
    const rows = ledger.listQueue();
    expect(rows.some((r) => r.id === id)).toBe(true);
    expect(rows.find((r) => r.id === id)!.priority_json).toBe("{not json");
  });
});

describe("listQueueRowsForScoring", () => {
  it("returns pending + approved only, id-ascending", () => {
    const pending = enqueue();
    const approved = enqueue();
    ledger.setQueueStatus({ id: approved, status: "approved" });
    const rejected = enqueue({ initialStatus: "rejected", notes: "auto: ICP — no" });
    const sent = enqueue();
    ledger.setQueueStatus({ id: sent, status: "sent" });
    const expired = enqueue({ initialStatus: "expired" });

    const rows = ledger.listQueueRowsForScoring();
    expect(rows.map((r) => r.id)).toEqual([pending, approved]);
    expect(rows.map((r) => r.id)).not.toContain(rejected);
    expect(rows.map((r) => r.id)).not.toContain(expired);
  });

  it("allStatuses widens to the full history for methodology evaluation", () => {
    const pending = enqueue();
    const rejected = enqueue({ initialStatus: "rejected", notes: "auto: ICP — no" });
    const sent = enqueue();
    ledger.setQueueStatus({ id: sent, status: "sent" });
    const ids = ledger.listQueueRowsForScoring({ allStatuses: true }).map((r) => r.id);
    expect(ids).toEqual([pending, rejected, sent]);
  });

  it("honors playName and limit", () => {
    enqueue();
    const other = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "s1",
      source: "find:show-hn",
    })!;
    expect(ledger.listQueueRowsForScoring({ playName: "show-hn" }).map((r) => r.id)).toEqual([
      other,
    ]);
    enqueue();
    expect(ledger.listQueueRowsForScoring({ limit: 1 })).toHaveLength(1);
  });
});
