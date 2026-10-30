import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

// Issue #983: a failed cross-workspace move puts the source row back through
// one compare-and-set UPDATE keyed on the note its reservation wrote. A row a
// later move (or the founder) rewrote meanwhile is left alone.

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-move-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function reserved(notes: string | null, status: "pending" | "approved" = "pending"): number {
  const id = ledger.enqueueTarget({
    playName: "show-hn",
    payload: { name: "Ada", email: "ada@example.com" },
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:show-hn",
  })!;
  if (status === "approved") ledger.setQueueStatus({ id, status: "approved" });
  if (notes) ledger.setQueueNotes({ id, notes });
  ledger.setQueueStatus({
    id,
    status: "rejected",
    decidedBy: "human",
    decisionReason: "other",
    notes: `${notes ? `${notes} · ` : ""}moved to alpha #1a2b3c4d`,
  });
  return id;
}

describe("Ledger.restoreQueueMoveIf", () => {
  it("puts status and notes back while the row still carries the reservation note", () => {
    const id = reserved("looks good", "approved");
    const ok = ledger.restoreQueueMoveIf({
      id,
      reservedNotes: "looks good · moved to alpha #1a2b3c4d",
      status: "approved",
      notes: "looks good",
    });
    expect(ok).toBe(true);
    const row = ledger.getQueueRow(id)!;
    expect(row).toMatchObject({ status: "approved", notes: "looks good", decision: "approve" });
    expect(row.decided_by).toBe("human");
    expect(row.send_started_at).toBeNull();
  });

  it("restores a pending row with no note to pending and a null note", () => {
    const id = reserved(null);
    expect(
      ledger.restoreQueueMoveIf({
        id,
        reservedNotes: "moved to alpha #1a2b3c4d",
        status: "pending",
        notes: null,
      }),
    ).toBe(true);
    expect(ledger.getQueueRow(id)).toMatchObject({
      status: "pending",
      notes: null,
      reviewed_at: null,
    });
  });

  it("leaves a row a later move re-reserved alone and says so", () => {
    const id = reserved(null);
    // A later move replaced the token.
    ledger.setQueueStatus({
      id,
      status: "rejected",
      decidedBy: "human",
      decisionReason: "other",
      notes: "moved to beta #9f8e7d6c",
    });
    expect(
      ledger.restoreQueueMoveIf({
        id,
        reservedNotes: "moved to alpha #1a2b3c4d",
        status: "pending",
        notes: null,
      }),
    ).toBe(false);
    expect(ledger.getQueueRow(id)).toMatchObject({
      status: "rejected",
      notes: "moved to beta #9f8e7d6c",
    });
  });

  it("never puts a row that was sent meanwhile back to pending", () => {
    const id = reserved(null);
    ledger.setQueueStatus({ id, status: "sent" });
    expect(
      ledger.restoreQueueMoveIf({
        id,
        reservedNotes: "moved to alpha #1a2b3c4d",
        status: "pending",
        notes: null,
      }),
    ).toBe(false);
    expect(ledger.getQueueRow(id)).toMatchObject({
      status: "sent",
      notes: "moved to alpha #1a2b3c4d",
    });
  });
});
