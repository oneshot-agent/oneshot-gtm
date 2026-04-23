import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../core/src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-find-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("target_queue lifecycle", () => {
  it("enqueues a row and lists it as pending", () => {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { postTitle: "Show HN: Acme", founderEmail: "a@acme.dev" },
      dedupeKey: "hn-1",
      source: "find:show-hn",
    });
    expect(id).not.toBeNull();
    const rows = ledger.listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.play_name).toBe("show-hn");
  });

  it("dedupes by (play_name, dedupe_key)", () => {
    const a = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { x: 1 },
      dedupeKey: "hn-42",
      source: "find:show-hn",
    });
    const b = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { x: 2 },
      dedupeKey: "hn-42",
      source: "find:show-hn",
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(ledger.isQueueDuplicate("show-hn", "hn-42")).toBe(true);
    // different play with same key should NOT collide
    const c = ledger.enqueueTarget({
      playName: "post-funding",
      payload: { x: 3 },
      dedupeKey: "hn-42",
      source: "find:post-funding",
    });
    expect(c).not.toBeNull();
  });

  it("setQueueStatus moves pending → approved → sent", () => {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "k1",
      source: "find:show-hn",
    });
    expect(id).not.toBeNull();
    ledger.setQueueStatus({ id: id!, status: "approved" });
    let row = ledger.getQueueRow(id!);
    expect(row?.status).toBe("approved");
    expect(row?.reviewed_at).not.toBeNull();
    ledger.setQueueStatus({ id: id!, status: "sent" });
    row = ledger.getQueueRow(id!);
    expect(row?.status).toBe("sent");
    expect(row?.sent_at).not.toBeNull();
  });

  it("approveAllPending only flips pending rows", () => {
    ledger.enqueueTarget({ playName: "show-hn", payload: {}, dedupeKey: "p1", source: "x" });
    const id2 = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "p2",
      source: "x",
    });
    ledger.setQueueStatus({ id: id2!, status: "rejected" });
    const n = ledger.approveAllPending();
    expect(n).toBe(1);
    const rows = ledger.listQueue();
    expect(rows.find((r) => r.dedupe_key === "p1")?.status).toBe("approved");
    expect(rows.find((r) => r.dedupe_key === "p2")?.status).toBe("rejected");
  });

  it("dequeueApproved returns approved rows for the play in FIFO order", () => {
    const a = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "a",
      source: "x",
    });
    const b = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "b",
      source: "x",
    });
    ledger.setQueueStatus({ id: a!, status: "approved" });
    ledger.setQueueStatus({ id: b!, status: "approved" });
    const drained = ledger.dequeueApproved({ playName: "show-hn", limit: 10 });
    expect(drained.map((r) => r.id)).toEqual([a, b]);
  });

  it("queueCounts groups by status", () => {
    const a = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "x1",
      source: "x",
    });
    const b = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "x2",
      source: "x",
    });
    const c = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "x3",
      source: "x",
    });
    ledger.setQueueStatus({ id: a!, status: "approved" });
    ledger.setQueueStatus({ id: b!, status: "rejected" });
    const counts = ledger.queueCounts();
    expect(counts.pending).toBe(1);
    expect(counts.approved).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.sent).toBe(0);
    expect(c).not.toBeNull();
  });
});

describe("trigger registry state", () => {
  it("upsert + getTrigger round-trips config", () => {
    ledger.upsertTrigger({
      name: "show-hn",
      configJson: JSON.stringify({ sinceDays: 1 }),
      enabled: true,
    });
    const t = ledger.getTrigger("show-hn");
    expect(t).not.toBeNull();
    expect(t?.enabled).toBe(1);
    expect(JSON.parse(t!.config_json ?? "{}")).toEqual({ sinceDays: 1 });
  });

  it("updateTriggerLastPoll sets last_polled_at + last_run_summary", () => {
    ledger.upsertTrigger({ name: "yc-w26", configJson: "{}" });
    ledger.updateTriggerLastPoll({ name: "yc-w26", summary: { found: 5, kept: 2 } });
    const t = ledger.getTrigger("yc-w26");
    expect(t?.last_polled_at).not.toBeNull();
    expect(JSON.parse(t!.last_run_summary ?? "{}")).toEqual({ found: 5, kept: 2 });
  });

  it("setTriggerEnabled flips the flag", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    ledger.setTriggerEnabled("show-hn", false);
    expect(ledger.getTrigger("show-hn")?.enabled).toBe(0);
    ledger.setTriggerEnabled("show-hn", true);
    expect(ledger.getTrigger("show-hn")?.enabled).toBe(1);
  });
});
