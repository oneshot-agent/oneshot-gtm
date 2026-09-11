import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

// Issue #592: the backfill writes through a guarded primitive, not a bare
// UPDATE — a row that got sent (or started sending) between listing and
// writing must be left alone, and the caller must be told.

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-payload-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function enqueue(payload: Record<string, unknown>, status?: "pending" | "approved" | "rejected") {
  const id = ledger.enqueueTarget({
    playName: "show-hn",
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:show-hn",
    ...(status ? { initialStatus: status } : {}),
  })!;
  if (status === "approved") ledger.setQueueStatus({ id, status: "approved" });
  return id;
}

function payloadOf(id: number): Record<string, unknown> {
  return JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;
}

describe("Ledger.patchLiveQueuePayload", () => {
  it("merges the patch into a pending or approved row and keeps the other keys", () => {
    const id = enqueue({ name: "A", postTitle: "Show HN: X" });
    expect(
      ledger.patchLiveQueuePayload({ id, patch: { fitReason: "fits", fitReasonSource: "notes" } }),
    ).toBe(true);
    expect(payloadOf(id)).toEqual({
      name: "A",
      postTitle: "Show HN: X",
      fitReason: "fits",
      fitReasonSource: "notes",
    });
    const approved = enqueue({ name: "B" }, "approved");
    expect(ledger.patchLiveQueuePayload({ id: approved, patch: { fitReason: "ok" } })).toBe(true);
    expect(payloadOf(approved)["fitReason"]).toBe("ok");
  });

  it("refuses a sent row, an in-flight row, a rejected row, and an unknown id", () => {
    const sent = enqueue({ name: "S" }, "approved");
    ledger.setQueueStatus({ id: sent, status: "sent" });
    expect(ledger.patchLiveQueuePayload({ id: sent, patch: { fitReason: "x" } })).toBe(false);
    expect(payloadOf(sent)["fitReason"]).toBeUndefined();

    const inflight = enqueue({ name: "I" }, "approved");
    expect(
      ledger.claimQueueSendingMarker({ id: inflight, startedAtIso: new Date().toISOString() }),
    ).toBe(true);
    expect(ledger.patchLiveQueuePayload({ id: inflight, patch: { fitReason: "x" } })).toBe(false);

    const rejected = enqueue({ name: "R" }, "rejected");
    expect(ledger.patchLiveQueuePayload({ id: rejected, patch: { fitReason: "x" } })).toBe(false);

    expect(ledger.patchLiveQueuePayload({ id: 999_999, patch: { fitReason: "x" } })).toBe(false);
  });
});

describe("atomic queue draft generation", () => {
  const draft = {
    subject: "s",
    body: "b",
    flags: [],
    sent: false,
    receiptIds: [],
    dryRun: true,
    angle: {
      text: "new argument",
      origin: "generated",
      fingerprint: "v1",
      history: ["new argument"],
    },
  };
  it("persists angle metadata and rejects a stale competing writer", () => {
    const id = enqueue({ name: "A" });
    const row = ledger.getQueueRow(id)!;
    const input = { id, previousDraft: null, previousPayload: row.payload_json, draft };
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(true);
    expect(JSON.parse(ledger.getQueueRow(id)!.last_draft_json!).angle).toEqual(draft.angle);
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(false);
    expect(ledger.getQueueRow(id)!.payload_json).toBe(row.payload_json);
  });
  it("does not overwrite after payload changes or a send", () => {
    const id = enqueue({ name: "A" });
    const row = ledger.getQueueRow(id)!;
    const input = { id, previousDraft: null, previousPayload: row.payload_json, draft };
    ledger.updateQueuePayload({ id, payload: { name: "B" } });
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(false);
    ledger.setQueueStatus({ id, status: "sent" });
    expect(
      ledger.setQueueDraftIfCurrent({
        ...input,
        previousPayload: ledger.getQueueRow(id)!.payload_json,
      }),
    ).toBe(false);
  });
});
