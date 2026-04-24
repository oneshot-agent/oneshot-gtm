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

  it("setTriggerConfig overwrites config_json", () => {
    ledger.upsertTrigger({
      name: "post-funding-auto",
      configJson: JSON.stringify({ autoSinceDays: 7 }),
    });
    ledger.setTriggerConfig("post-funding-auto", JSON.stringify({ autoSinceDays: 14, limit: 50 }));
    const t = ledger.getTrigger("post-funding-auto");
    expect(JSON.parse(t!.config_json ?? "{}")).toEqual({ autoSinceDays: 14, limit: 50 });
  });
});

describe("trigger run-state persistence (survives restart)", () => {
  it("markTriggerRunning sets running_started_at + returns true on first claim", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    expect(ledger.getTrigger("show-hn")?.running_started_at).toBeNull();
    const iso = "2026-04-24T18:23:54.607Z";
    expect(ledger.markTriggerRunning("show-hn", iso)).toBe(true);
    expect(ledger.getTrigger("show-hn")?.running_started_at).toBe(iso);
  });

  it("markTriggerRunning is atomic: second concurrent claim returns false", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    expect(ledger.markTriggerRunning("show-hn", "2026-04-24T18:00:00Z")).toBe(true);
    // Second call without a clearing updateTriggerLastPoll in between MUST
    // be rejected. Closes the TOCTOU race two concurrent fireTriggerNow
    // calls would otherwise hit.
    expect(ledger.markTriggerRunning("show-hn", "2026-04-24T18:01:00Z")).toBe(false);
    // Original timestamp preserved — the second claim doesn't overwrite.
    expect(ledger.getTrigger("show-hn")?.running_started_at).toBe("2026-04-24T18:00:00Z");
  });

  it("markTriggerRunning returns false when the row doesn't exist (UPDATE no-op)", () => {
    expect(ledger.markTriggerRunning("never-seen", "2026-04-24T18:00:00Z")).toBe(false);
  });

  it("markTriggerRunning succeeds again after updateTriggerLastPoll clears the flag", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    expect(ledger.markTriggerRunning("show-hn", "2026-04-24T18:00:00Z")).toBe(true);
    ledger.updateTriggerLastPoll({ name: "show-hn", summary: { ok: true } });
    // After clear, a fresh fire is allowed.
    expect(ledger.markTriggerRunning("show-hn", "2026-04-24T18:30:00Z")).toBe(true);
  });

  it("updateTriggerLastPoll clears running_started_at in the same write", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    ledger.markTriggerRunning("show-hn", "2026-04-24T18:23:54.607Z");
    expect(ledger.getTrigger("show-hn")?.running_started_at).not.toBeNull();
    ledger.updateTriggerLastPoll({ name: "show-hn", summary: { kept: 3 } });
    const t = ledger.getTrigger("show-hn");
    expect(t?.running_started_at).toBeNull();
    expect(t?.last_polled_at).not.toBeNull();
    expect(JSON.parse(t!.last_run_summary ?? "{}")).toEqual({ kept: 3 });
  });

  it("sweepStaleRunningTriggers returns [] when nothing is in flight", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    const swept = ledger.sweepStaleRunningTriggers({
      now: new Date("2026-04-24T19:00:00Z"),
      maxAgeMs: 15 * 60_000,
    });
    expect(swept).toEqual([]);
  });

  it("sweepStaleRunningTriggers spares fresh in-flight rows", () => {
    ledger.upsertTrigger({ name: "agent-builders", configJson: "{}" });
    ledger.markTriggerRunning("agent-builders", "2026-04-24T18:55:00Z");
    const swept = ledger.sweepStaleRunningTriggers({
      now: new Date("2026-04-24T19:00:00Z"), // 5 min in
      maxAgeMs: 15 * 60_000,
    });
    expect(swept).toEqual([]);
    expect(ledger.getTrigger("agent-builders")?.running_started_at).toBe(
      "2026-04-24T18:55:00Z",
    );
  });

  it("sweepStaleRunningTriggers sweeps stale rows + writes killed_by_restart", () => {
    ledger.upsertTrigger({ name: "agent-builders", configJson: "{}" });
    ledger.markTriggerRunning("agent-builders", "2026-04-24T18:23:54.607Z");
    const now = new Date("2026-04-24T19:30:00Z"); // > 15 min after start
    const swept = ledger.sweepStaleRunningTriggers({ now, maxAgeMs: 15 * 60_000 });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.name).toBe("agent-builders");
    expect(swept[0]?.startedAt).toBe("2026-04-24T18:23:54.607Z");
    expect(swept[0]?.ageMs).toBeGreaterThan(15 * 60_000);
    const t = ledger.getTrigger("agent-builders");
    expect(t?.running_started_at).toBeNull();
    expect(t?.last_polled_at).toBe(now.toISOString());
    const summary = JSON.parse(t!.last_run_summary ?? "{}") as { error: string; ageMs: number };
    expect(summary.error).toBe("killed_by_restart");
    expect(summary.ageMs).toBeGreaterThan(15 * 60_000);
  });

  it("sweepStaleRunningTriggers handles a garbage timestamp by clearing the row", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}" });
    ledger.markTriggerRunning("show-hn", "this is not a valid date");
    const swept = ledger.sweepStaleRunningTriggers({
      now: new Date("2026-04-24T19:00:00Z"),
      maxAgeMs: 15 * 60_000,
    });
    // Garbage isn't reported as a successful sweep (no ageMs), but the row
    // is still cleared so it doesn't perpetually re-trip.
    expect(ledger.getTrigger("show-hn")?.running_started_at).toBeNull();
    const summary = JSON.parse(
      ledger.getTrigger("show-hn")!.last_run_summary ?? "{}",
    ) as { error: string; reason?: string };
    expect(summary.error).toBe("killed_by_restart");
    expect(summary.reason).toContain("unparseable");
    expect(swept).toEqual([]);
  });

  it("sweepStaleRunningTriggers across many rows: keeps fresh, sweeps stale", () => {
    ledger.upsertTrigger({ name: "fresh", configJson: "{}" });
    ledger.upsertTrigger({ name: "stale", configJson: "{}" });
    ledger.upsertTrigger({ name: "idle", configJson: "{}" });
    ledger.markTriggerRunning("fresh", "2026-04-24T18:55:00Z");
    ledger.markTriggerRunning("stale", "2026-04-24T17:00:00Z");
    // "idle" has no running_started_at — should never appear in the sweep.
    const swept = ledger.sweepStaleRunningTriggers({
      now: new Date("2026-04-24T19:00:00Z"),
      maxAgeMs: 15 * 60_000,
    });
    expect(swept.map((s) => s.name)).toEqual(["stale"]);
    expect(ledger.getTrigger("fresh")?.running_started_at).not.toBeNull();
    expect(ledger.getTrigger("stale")?.running_started_at).toBeNull();
    expect(ledger.getTrigger("idle")?.last_run_summary).toBeNull();
  });
});
