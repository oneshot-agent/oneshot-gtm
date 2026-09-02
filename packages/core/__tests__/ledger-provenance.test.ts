import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { isHumanApproval, isHumanDecision } from "../src/labels.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-provenance-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function enqueue(overrides: Record<string, unknown> = {}): number {
  return ledger.enqueueTarget({
    playName: "post-funding",
    payload: { name: "Ada", email: "ada@acme.dev" },
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:post-funding",
    ...overrides,
  })!;
}

const rawDb = (): Database => (ledger as unknown as { db: Database }).db;

describe("decision provenance writes (v26)", () => {
  it("per-row human approve/reject stamp decision columns", () => {
    const a = enqueue();
    ledger.setQueueStatus({ id: a, status: "approved", decidedBy: "human" });
    const row = ledger.getQueueRow(a)!;
    expect(row.decision).toBe("approve");
    expect(row.decided_by).toBe("human");
    expect(row.decided_at).not.toBeNull();

    const r = enqueue();
    ledger.setQueueStatus({
      id: r,
      status: "rejected",
      notes: "wrong segment",
      decidedBy: "human",
    });
    expect(ledger.getQueueRow(r)!.decision).toBe("reject");
    expect(ledger.getQueueRow(r)!.decided_by).toBe("human");
  });

  it("an unannotated rejection is a machine decision — callers can't mint human labels by default", () => {
    const id = enqueue();
    ledger.setQueueStatus({ id, status: "rejected", notes: "auto: dedup — not re-sent" });
    const row = ledger.getQueueRow(id)!;
    expect(row.decision).toBe("auto_reject");
    expect(row.decided_by).toBe("machine");
    expect(isHumanDecision(row)).toBe(false);
  });

  it("a machine send never overwrites the human approve (COALESCE)", () => {
    const id = enqueue();
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    const decidedAt = ledger.getQueueRow(id)!.decided_at;
    ledger.setQueueStatus({ id, status: "sent" }); // drain — machine default
    const row = ledger.getQueueRow(id)!;
    expect(row.status).toBe("sent");
    expect(row.decision).toBe("approve");
    expect(row.decided_by).toBe("human");
    expect(row.decided_at).toBe(decidedAt);
  });

  it("a send on a never-decided row records an honest machine disposition", () => {
    const id = enqueue();
    ledger.setQueueStatus({ id, status: "sent" });
    const row = ledger.getQueueRow(id)!;
    expect(row.decision).toBe("approve");
    expect(row.decided_by).toBe("machine");
    expect(isHumanDecision(row)).toBe(false);
  });

  it("re-open to pending keeps the decision; a re-decide overwrites (latest wins)", () => {
    const id = enqueue();
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    ledger.setQueueStatus({ id, status: "pending" });
    let row = ledger.getQueueRow(id)!;
    expect(row.reviewed_at).toBeNull();
    expect(row.decision).toBe("approve");
    ledger.setQueueStatus({ id, status: "rejected", notes: "second look", decidedBy: "human" });
    row = ledger.getQueueRow(id)!;
    expect(row.decision).toBe("reject");
  });

  it("enqueueTarget auto-rejection is structurally machine-decided", () => {
    const id = enqueue({ initialStatus: "rejected", notes: "auto: ICP — no" });
    const row = ledger.getQueueRow(id)!;
    expect(row.decision).toBe("auto_reject");
    expect(row.decided_by).toBe("machine");
    expect(row.reviewed_at).not.toBeNull(); // existing behavior preserved
  });

  it("approveAllPending marks the batch human_bulk", () => {
    const a = enqueue();
    const b = enqueue();
    ledger.approveAllPending();
    for (const id of [a, b]) {
      const row = ledger.getQueueRow(id)!;
      expect(row.decision).toBe("approve");
      expect(row.decided_by).toBe("human_bulk");
      expect(isHumanApproval(row)).toBe(true); // bulk counts as human (parity)
    }
  });
});

describe("expiry never destroys a decision (the Phase 3 point)", () => {
  it("a prospect replying expires the approved breakup-revive row but keeps the label", () => {
    const prospectId = ledger.upsertProspect({ email: "rae@acme.dev", name: "Rae" });
    const id = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: { email: "rae@acme.dev", daysCold: 14 },
      dedupeKey: `prospect:${prospectId}`,
      source: "find:breakup-revive",
    })!;
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    ledger.recordProspectReply(prospectId); // used to destroy the approval
    const row = ledger.getQueueRow(id)!;
    expect(row.status).toBe("expired");
    expect(row.notes).toContain("expired: prospect replied");
    expect(row.decision).toBe("approve");
    expect(row.decided_by).toBe("human");
    expect(isHumanApproval(row)).toBe(true);
  });

  it("expirePendingOlderThan leaves undecided rows undecided", () => {
    const id = enqueue();
    rawDb()
      .prepare(`UPDATE target_queue SET found_at = '2020-01-01 00:00:00' WHERE id = ?`)
      .run(id);
    ledger.expirePendingOlderThan(1);
    const row = ledger.getQueueRow(id)!;
    expect(row.status).toBe("expired");
    expect(row.decision).toBeNull();
    expect(isHumanDecision(row)).toBe(false);
  });
});

describe("backfillDecisionProvenance", () => {
  /** Insert a legacy-shaped row with NULL decision columns via raw SQL. */
  function legacyRow(input: {
    status: string;
    reviewedAt: string | null;
    notes?: string | null;
    play?: string;
  }): number {
    const result = rawDb()
      .prepare(
        `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, reviewed_at, notes)
         VALUES(?, '{}', ?, 'test', ?, ?, ?)`,
      )
      .run(
        input.play ?? "post-funding",
        `legacy-${Math.random().toString(36).slice(2)}`,
        input.status,
        input.reviewedAt,
        input.notes ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  function reopen(): void {
    ledger.close();
    ledger = new Ledger(dbPath); // backfill runs on boot
  }

  it("classifies legacy rows: single approvals, bulk clusters, human and auto rejections", () => {
    const single = legacyRow({ status: "approved", reviewedAt: "2026-08-01T10:00:00.000Z" });
    const bulkIds = Array.from({ length: 21 }, () =>
      legacyRow({
        status: "approved",
        reviewedAt: "2026-08-02T10:00:00.000Z",
        play: "luma-events",
      }),
    );
    const humanReject = legacyRow({ status: "rejected", reviewedAt: "2026-08-01T11:00:00.000Z" }); // NULL notes
    const autoReject = legacyRow({
      status: "rejected",
      reviewedAt: "2026-08-01T12:00:00.000Z",
      notes: "auto: ICP — no",
    });
    const expired = legacyRow({ status: "expired", reviewedAt: "2026-08-01T13:00:00.000Z" });
    reopen();

    expect(ledger.getQueueRow(single)!.decision).toBe("approve");
    expect(ledger.getQueueRow(single)!.decided_by).toBe("human");
    expect(ledger.getQueueRow(bulkIds[0]!)!.decided_by).toBe("human_bulk");
    const hr = ledger.getQueueRow(humanReject)!;
    expect(hr.decision).toBe("reject"); // NULL notes must not read as auto (3VL guard)
    expect(hr.decided_by).toBe("human");
    expect(ledger.getQueueRow(autoReject)!.decision).toBe("auto_reject");
    // Expired history is not fabricated.
    expect(ledger.getQueueRow(expired)!.decision).toBeNull();
  });

  it("is idempotent across re-opens and never overwrites live-written provenance", () => {
    const id = enqueue();
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    const before = ledger.getQueueRow(id)!;
    reopen();
    reopen();
    expect(ledger.getQueueRow(id)).toEqual(before);
  });

  it("parity: label predicates agree before and after backfill", () => {
    const rows = [
      legacyRow({ status: "approved", reviewedAt: "2026-08-01T10:00:00.000Z" }),
      legacyRow({ status: "sent", reviewedAt: "2026-08-01T10:00:01.000Z" }),
      legacyRow({ status: "rejected", reviewedAt: "2026-08-01T10:00:02.000Z", notes: "meh" }),
      legacyRow({
        status: "rejected",
        reviewedAt: "2026-08-01T10:00:03.000Z",
        notes: "auto: role — no",
      }),
      legacyRow({ status: "expired", reviewedAt: "2026-08-01T10:00:04.000Z" }),
      legacyRow({ status: "pending", reviewedAt: null }),
    ];
    const before = rows.map((id) => {
      const row = ledger.getQueueRow(id)!;
      return [isHumanDecision(row), isHumanApproval(row)];
    });
    reopen();
    const after = rows.map((id) => {
      const row = ledger.getQueueRow(id)!;
      return [isHumanDecision(row), isHumanApproval(row)];
    });
    expect(after).toEqual(before);
  });
});
