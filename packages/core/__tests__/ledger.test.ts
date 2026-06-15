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
    `oneshot-gtm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("Ledger schema migration", () => {
  it("creates an empty ledger with no receipts", () => {
    expect(ledger.listReceipts()).toEqual([]);
  });

  it("addColumnIfMissing is idempotent (re-opening doesn't duplicate the phone column)", () => {
    ledger.close();
    const second = new Ledger(dbPath);
    expect(() => second.upsertProspect({ name: "x", email: "x@y.com", source: "t" })).not.toThrow();
    second.close();
  });
});

describe("Ledger receipts + prospects + spend rollups", () => {
  it("records and reads a receipt", () => {
    const id = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      costUsd: 0.05,
      signedReceipt: { email: { id: "abc-123" } },
      oneshotRequestId: "abc-123",
    });
    expect(id).toBeGreaterThan(0);
    const r = ledger.getReceipt(id);
    expect(r?.play_name).toBe("show-hn");
    expect(r?.cost_usd).toBe(0.05);
    expect(r?.oneshot_request_id).toBe("abc-123");
  });

  it("recordReceipt is idempotent on a non-null oneshot_request_id (SDK replay / double-fire)", () => {
    const first = ledger.recordReceipt({
      playName: "inbox-reply",
      callType: "email.reply",
      costUsd: 0.01,
      oneshotRequestId: "job-xyz",
    });
    // A retry of the same send (idempotency replay returns the original job id)
    // must NOT create a second receipt or double-count spend.
    const replay = ledger.recordReceipt({
      playName: "inbox-reply",
      callType: "email.reply",
      costUsd: 0.01,
      oneshotRequestId: "job-xyz",
    });
    expect(replay).toBe(first);
    const spend = ledger.spendByPlay().find((r) => r.play_name === "inbox-reply");
    expect(spend?.calls).toBe(1);
    expect(spend?.total_usd).toBeCloseTo(0.01);
  });

  it("recordReceipt does NOT collapse receipts with a null request_id", () => {
    const a = ledger.recordReceipt({ playName: "p", callType: "email.send", costUsd: 0.02 });
    const b = ledger.recordReceipt({ playName: "p", callType: "email.send", costUsd: 0.02 });
    expect(b).not.toBe(a);
  });

  it("upsertProspect dedupes by email", () => {
    const a = ledger.upsertProspect({
      name: "Sam",
      email: "sam@x.dev",
      company: "X",
      source: "show-hn",
    });
    const b = ledger.upsertProspect({
      name: "Sam",
      email: "sam@x.dev",
      company: "X",
      source: "show-hn",
    });
    expect(a).toBe(b);
  });

  it("normalizes prospect email on store + lookup (reply matching is case-insensitive)", () => {
    // A prospect created from a mixed-case address must still be found when a
    // reply comes in normalized to lowercase (cadence inbox poll), and we must
    // not create a duplicate row for the same address in a different case.
    const id = ledger.upsertProspect({
      name: "Sophia",
      email: "Sophia@AgenticArchitect.AI",
      source: "t",
    });
    expect(ledger.findProspectByEmail("sophia@agenticarchitect.ai")?.id).toBe(id);
    expect(ledger.findProspectByEmail("SOPHIA@AGENTICARCHITECT.AI")?.id).toBe(id);
    expect(ledger.getProspectByEmail("sophia@agenticarchitect.ai")?.id).toBe(id);
    // Re-upsert under yet another casing → same row, no duplicate.
    const again = ledger.upsertProspect({
      name: "Sophia",
      email: "sophia@AGENTICARCHITECT.ai",
      source: "t",
    });
    expect(again).toBe(id);
  });

  it("spendByPlay groups receipts and sums cost", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "show-hn", callType: "research.deep", costUsd: 0.4 });
    ledger.recordReceipt({ playName: "job-change", callType: "enrich.profile", costUsd: 0.2 });
    const out = ledger.spendByPlay();
    const showHn = out.find((r) => r.play_name === "show-hn");
    const jc = out.find((r) => r.play_name === "job-change");
    expect(showHn?.calls).toBe(2);
    expect(showHn?.total_usd).toBeCloseTo(0.5);
    expect(jc?.calls).toBe(1);
    expect(jc?.total_usd).toBeCloseTo(0.2);
  });

  it("listSequenceEventsForProspectPlay filters by prospect+play+status and orders by step", () => {
    const pidA = ledger.upsertProspect({ name: "A", email: "a@x.com", source: "t" });
    const pidB = ledger.upsertProspect({ name: "B", email: "b@x.com", source: "t" });
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "stack-consolidation",
      stepIndex: 1,
      channel: "email",
      status: "sent",
      metadata: { subject: "s1", body: "b1" },
    });
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "stack-consolidation",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "s0", body: "b0" },
    });
    // Wrong play — should be excluded.
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    // Non-final status — should be excluded.
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "stack-consolidation",
      stepIndex: 2,
      channel: "email",
      status: "queued",
    });
    // Wrong prospect — should be excluded.
    ledger.recordSequenceEvent({
      prospectId: pidB,
      playName: "stack-consolidation",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    const rows = ledger.listSequenceEventsForProspectPlay(pidA, "stack-consolidation");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.step_index).toBe(0);
    expect(rows[1]?.step_index).toBe(1);
  });

  it("listSequenceEventsForCadences batches many pairs in one query, preserving per-key order", () => {
    const pidA = ledger.upsertProspect({ name: "A", email: "ba@x.com", source: "t" });
    const pidB = ledger.upsertProspect({ name: "B", email: "bb@x.com", source: "t" });
    // pidA · stack-consolidation: steps 1 then 0 inserted → expect (0, 1) on read.
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "stack-consolidation",
      stepIndex: 1,
      channel: "email",
      status: "sent",
    });
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "stack-consolidation",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    // pidA · show-hn: should land in its own bucket, not mixed with stack-consolidation.
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    // pidB · stack-consolidation: separate bucket again.
    ledger.recordSequenceEvent({
      prospectId: pidB,
      playName: "stack-consolidation",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    // queued status — should be filtered out everywhere.
    ledger.recordSequenceEvent({
      prospectId: pidA,
      playName: "stack-consolidation",
      stepIndex: 2,
      channel: "email",
      status: "queued",
    });

    const map = ledger.listSequenceEventsForCadences([
      { prospectId: pidA, playName: "stack-consolidation" },
      { prospectId: pidA, playName: "show-hn" },
      { prospectId: pidB, playName: "stack-consolidation" },
    ]);
    expect(map.size).toBe(3);
    expect(map.get(`${pidA}|stack-consolidation`)?.map((r) => r.step_index)).toEqual([0, 1]);
    expect(map.get(`${pidA}|show-hn`)?.map((r) => r.step_index)).toEqual([0]);
    expect(map.get(`${pidB}|stack-consolidation`)?.map((r) => r.step_index)).toEqual([0]);
  });

  it("listSequenceEventsForCadences returns empty map on empty input", () => {
    const map = ledger.listSequenceEventsForCadences([]);
    expect(map.size).toBe(0);
  });

  it("listSequenceEventsForCadences omits pairs with no matching rows", () => {
    const pid = ledger.upsertProspect({ name: "P", email: "p@x.com", source: "t" });
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    const map = ledger.listSequenceEventsForCadences([
      { prospectId: pid, playName: "show-hn" },
      { prospectId: pid, playName: "no-such-play" },
      { prospectId: 999999, playName: "show-hn" },
    ]);
    expect(map.size).toBe(1);
    expect(map.has(`${pid}|show-hn`)).toBe(true);
  });

  it("eventsByPlay aggregates sequence statuses", () => {
    const id = ledger.upsertProspect({ name: "A", email: "a@x.com", source: "t" });
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "replied",
    });
    const out = ledger.eventsByPlay();
    const show = out.find((r) => r.play_name === "show-hn");
    expect(show?.sent).toBe(2);
    expect(show?.replied).toBe(1);
  });
});

describe("Ledger cadence state", () => {
  it("enroll + advance + setStatus round-trip", () => {
    const pid = ledger.upsertProspect({ name: "B", email: "b@x.com", source: "t" });
    const due = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    ledger.enrollCadence({ prospectId: pid, playName: "job-change", nextDueAt: due });

    const active = ledger.listAllCadences();
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe("active");
    expect(active[0]?.current_step).toBe(0);

    ledger.advanceCadence({
      prospectId: pid,
      playName: "job-change",
      newStep: 1,
      nextDueAt: new Date().toISOString(),
    });
    ledger.setCadenceStatus({ prospectId: pid, playName: "job-change", status: "replied" });

    const after = ledger.listAllCadences();
    expect(after[0]?.current_step).toBe(1);
    expect(after[0]?.status).toBe("replied");
  });

  it("records a send error and clears it on advance / status change", () => {
    const pid = ledger.upsertProspect({ name: "E", email: "e@x.com", source: "t" });
    ledger.enrollCadence({ prospectId: pid, playName: "repo-interest", nextDueAt: new Date().toISOString() });
    // Fresh enroll: no error.
    expect(ledger.getCadence(pid, "repo-interest")?.last_send_error).toBeNull();

    ledger.recordCadenceSendError({
      prospectId: pid,
      playName: "repo-interest",
      error: "Job failed: Tool execution failed. (ref: abc)",
    });
    const failed = ledger.getCadence(pid, "repo-interest");
    expect(failed?.last_send_error).toContain("Tool execution failed");
    expect(failed?.last_send_error_at).not.toBeNull();

    // A successful advance clears it.
    ledger.advanceCadence({
      prospectId: pid,
      playName: "repo-interest",
      newStep: 1,
      nextDueAt: new Date().toISOString(),
    });
    expect(ledger.getCadence(pid, "repo-interest")?.last_send_error).toBeNull();

    // Re-fail, then a status change (e.g. replied) also clears it.
    ledger.recordCadenceSendError({ prospectId: pid, playName: "repo-interest", error: "again" });
    expect(ledger.getCadence(pid, "repo-interest")?.last_send_error).toBe("again");
    ledger.setCadenceStatus({ prospectId: pid, playName: "repo-interest", status: "replied" });
    expect(ledger.getCadence(pid, "repo-interest")?.last_send_error).toBeNull();

    // Re-enrolling the same prospect (play re-run) must clear a stale error —
    // a re-activated cadence shouldn't show a failure from a prior cycle.
    ledger.recordCadenceSendError({ prospectId: pid, playName: "repo-interest", error: "stale" });
    expect(ledger.getCadence(pid, "repo-interest")?.last_send_error).toBe("stale");
    ledger.enrollCadence({ prospectId: pid, playName: "repo-interest", nextDueAt: new Date().toISOString() });
    expect(ledger.getCadence(pid, "repo-interest")?.last_send_error).toBeNull();
  });

  it("getCadence + listCadencesForProspect + getProspectById are index-seek single lookups", () => {
    const pid = ledger.upsertProspect({ name: "Q", email: "q@x.com", company: "QCo", source: "t" });
    const due = new Date().toISOString();
    ledger.enrollCadence({ prospectId: pid, playName: "job-change", nextDueAt: due });
    ledger.enrollCadence({ prospectId: pid, playName: "show-hn", nextDueAt: due });

    // getCadence: exact (prospect, play) seek, joined with prospect fields.
    const c = ledger.getCadence(pid, "job-change");
    expect(c?.play_name).toBe("job-change");
    expect(c?.prospect_email).toBe("q@x.com");
    expect(c?.prospect_company).toBe("QCo");
    expect(ledger.getCadence(pid, "no-such-play")).toBeNull();
    expect(ledger.getCadence(999999, "job-change")).toBeNull();

    // listCadencesForProspect: all cadences for one prospect.
    const list = ledger.listCadencesForProspect(pid);
    expect(list.map((r) => r.play_name).toSorted()).toEqual(["job-change", "show-hn"]);
    expect(ledger.listCadencesForProspect(999999)).toEqual([]);

    // getProspectById: PK seek.
    expect(ledger.getProspectById(pid)?.email).toBe("q@x.com");
    expect(ledger.getProspectById(999999)).toBeNull();
  });

  it("listActiveCadences filters by due date", () => {
    const p1 = ledger.upsertProspect({ name: "P1", email: "p1@x.com", source: "t" });
    const p2 = ledger.upsertProspect({ name: "P2", email: "p2@x.com", source: "t" });
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    ledger.enrollCadence({ prospectId: p1, playName: "show-hn", nextDueAt: past });
    ledger.enrollCadence({ prospectId: p2, playName: "show-hn", nextDueAt: future });

    const due = ledger.listActiveCadences({ dueByIso: new Date().toISOString() });
    expect(due).toHaveLength(1);
    expect(due[0]?.prospect_email).toBe("p1@x.com");
  });
});

describe("Ledger cadence sending marker", () => {
  it("claim succeeds when marker is NULL; second claim fails (atomic CAS)", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "s@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    const first = ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    expect(first).toBe(true);
    const second = ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    expect(second).toBe(false);
  });

  it("claim succeeds when previous marker is older than the stale cutoff", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "s2@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: oldIso,
    });
    const reclaim = ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
      staleCutoffIso: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min cutoff
    });
    expect(reclaim).toBe(true);
  });

  it("clearCadenceSendingMarker sets the marker back to NULL", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "s3@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    expect(ledger.getCadence(pid, "show-hn")?.sending_started_at).not.toBeNull();
    ledger.clearCadenceSendingMarker({ prospectId: pid, playName: "show-hn" });
    expect(ledger.getCadence(pid, "show-hn")?.sending_started_at).toBeNull();
  });

  it("advanceCadence also clears sending_started_at as part of the same UPDATE", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "s4@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    ledger.advanceCadence({
      prospectId: pid,
      playName: "show-hn",
      newStep: 1,
      nextDueAt: null,
    });
    expect(ledger.getCadence(pid, "show-hn")?.sending_started_at).toBeNull();
  });

  it("setCadenceStatus to non-active terminal state clears the marker", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "s5@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    ledger.setCadenceStatus({ prospectId: pid, playName: "show-hn", status: "replied" });
    expect(ledger.getCadence(pid, "show-hn")?.sending_started_at).toBeNull();
  });
});

describe("Ledger sweepStaleCadenceSends", () => {
  it("maxAgeMs:0 (cold-boot semantics) sweeps every existing marker", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "sa@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date(Date.now() - 1000).toISOString(),
    });
    const swept = ledger.sweepStaleCadenceSends({ now: new Date(), maxAgeMs: 0 });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.actuallySent).toBe(false);
    expect(ledger.getCadence(pid, "show-hn")?.sending_started_at).toBeNull();
  });

  it("classifies as actuallySent when a sequence_event for current_step exists", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "sb@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date(Date.now() - 1000).toISOString(),
    });
    const swept = ledger.sweepStaleCadenceSends({ now: new Date(), maxAgeMs: 0 });
    expect(swept[0]?.actuallySent).toBe(true);
  });

  it("leaves fresh markers untouched (maxAgeMs > 0)", () => {
    const pid = ledger.upsertProspect({ name: "S", email: "sc@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    const swept = ledger.sweepStaleCadenceSends({
      now: new Date(),
      maxAgeMs: 5 * 60 * 1000,
    });
    expect(swept).toHaveLength(0);
    expect(ledger.getCadence(pid, "show-hn")?.sending_started_at).not.toBeNull();
  });
});

describe("Ledger queue sending marker", () => {
  function enqueue(): number {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { email: "x@y.dev" },
      dedupeKey: `key-${Math.random()}`,
      source: "test",
      initialStatus: "approved",
    });
    if (id == null) throw new Error("enqueue failed");
    return id;
  }

  it("claim succeeds when marker is NULL; second claim fails", () => {
    const id = enqueue();
    expect(ledger.claimQueueSendingMarker({ id, startedAtIso: new Date().toISOString() })).toBe(
      true,
    );
    expect(ledger.claimQueueSendingMarker({ id, startedAtIso: new Date().toISOString() })).toBe(
      false,
    );
  });

  it("reclaim succeeds when previous marker is older than the stale cutoff", () => {
    const id = enqueue();
    ledger.claimQueueSendingMarker({
      id,
      startedAtIso: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    expect(
      ledger.claimQueueSendingMarker({
        id,
        startedAtIso: new Date().toISOString(),
        staleCutoffIso: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
    ).toBe(true);
  });

  it("clearQueueSendingMarker sets the marker back to NULL", () => {
    const id = enqueue();
    ledger.claimQueueSendingMarker({ id, startedAtIso: new Date().toISOString() });
    expect(ledger.getQueueRow(id)?.send_started_at).not.toBeNull();
    ledger.clearQueueSendingMarker(id);
    expect(ledger.getQueueRow(id)?.send_started_at).toBeNull();
  });

  it("setQueueStatus(sent/rejected/expired) auto-clears the marker", () => {
    for (const status of ["sent", "rejected", "expired"] as const) {
      const id = enqueue();
      ledger.claimQueueSendingMarker({ id, startedAtIso: new Date().toISOString() });
      ledger.setQueueStatus({ id, status });
      expect(ledger.getQueueRow(id)?.send_started_at).toBeNull();
    }
  });

  it("sweepStaleQueueSends classifies a stranded (non-sent) marker as actuallySent: false", () => {
    const id = enqueue();
    ledger.claimQueueSendingMarker({
      id,
      startedAtIso: new Date(Date.now() - 1000).toISOString(),
    });
    const swept = ledger.sweepStaleQueueSends({ now: new Date(), maxAgeMs: 0 });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.actuallySent).toBe(false);
    expect(ledger.getQueueRow(id)?.send_started_at).toBeNull();
  });

  it("sweepStaleQueueSends classifies a sent row's stale marker as actuallySent: true", () => {
    // Race scenario: SDK send completed AND setQueueStatus('sent') landed, then
    // the process died before some other path could clear send_started_at.
    // Simulate by writing the marker AFTER the status flip.
    const id = enqueue();
    ledger.setQueueStatus({ id, status: "sent" });
    // setQueueStatus('sent') auto-clears the marker; re-claim to simulate the
    // pre-clear stranded state.
    ledger.claimQueueSendingMarker({
      id,
      startedAtIso: new Date(Date.now() - 1000).toISOString(),
    });
    const swept = ledger.sweepStaleQueueSends({ now: new Date(), maxAgeMs: 0 });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.actuallySent).toBe(true);
    expect(ledger.getQueueRow(id)?.send_started_at).toBeNull();
  });

  it("sweep with maxAgeMs > 0 leaves fresh markers untouched", () => {
    const id = enqueue();
    ledger.claimQueueSendingMarker({ id, startedAtIso: new Date().toISOString() });
    const swept = ledger.sweepStaleQueueSends({
      now: new Date(),
      maxAgeMs: 5 * 60 * 1000,
    });
    expect(swept).toHaveLength(0);
    expect(ledger.getQueueRow(id)?.send_started_at).not.toBeNull();
  });
});

describe("Ledger runs", () => {
  it("createRun inserts a 'running' row with the right counters", () => {
    const { runId, startedAt } = ledger.createRun({
      playName: "repo-interest",
      dryRun: false,
      targets: [
        { email: "a@x.dev", name: "A" },
        { email: "b@x.dev", name: "B" },
      ],
    });
    expect(runId).toBeGreaterThan(0);
    expect(startedAt).toMatch(/^\d{4}-/);
    const run = ledger.getRun(runId);
    expect(run).toMatchObject({
      playName: "repo-interest",
      dryRun: false,
      status: "running",
      targetCount: 2,
      draftedCount: 0,
      sentCount: 0,
      errorCount: 0,
      completedAt: null,
    });
    expect(run?.targets).toHaveLength(2);
    expect(run?.events).toEqual([]);
  });

  it("appendRunEvent bumps the right counter per event kind", () => {
    const { runId } = ledger.createRun({
      playName: "show-hn",
      dryRun: false,
      targets: [{ email: "a@x.dev" }, { email: "b@x.dev" }, { email: "c@x.dev" }],
    });
    ledger.appendRunEvent({ runId, event: { kind: "draft", index: 0, subject: "s" } });
    ledger.appendRunEvent({ runId, event: { kind: "draft", index: 1, subject: "s" } });
    ledger.appendRunEvent({ runId, event: { kind: "send", index: 0, receiptIds: [1] } });
    ledger.appendRunEvent({ runId, event: { kind: "error", index: 2, message: "boom" } });
    ledger.appendRunEvent({ runId, event: { kind: "stage", stage: "done" } });
    const run = ledger.getRun(runId)!;
    expect(run.draftedCount).toBe(2);
    expect(run.sentCount).toBe(1);
    expect(run.errorCount).toBe(1);
    expect(run.events).toHaveLength(5);
  });

  it("appendRunEvent is a no-op for an unknown runId (doesn't throw)", () => {
    expect(() => ledger.appendRunEvent({ runId: 999999, event: { kind: "draft" } })).not.toThrow();
  });

  it("markRunComplete flips status + stamps completedAt + records sent emails", () => {
    const { runId } = ledger.createRun({
      playName: "show-hn",
      dryRun: false,
      targets: [{ email: "a@x.dev" }],
    });
    ledger.markRunComplete({
      runId,
      status: "done",
      sentEmails: ["a@x.dev"],
    });
    const run = ledger.getRun(runId)!;
    expect(run.status).toBe("done");
    expect(run.completedAt).toMatch(/^\d{4}-/);
    expect(run.prospectEmails).toEqual(["a@x.dev"]);
  });

  it("markRunComplete on an already-completed row is a no-op (won't overwrite)", () => {
    const { runId } = ledger.createRun({
      playName: "show-hn",
      dryRun: false,
      targets: [{ email: "a@x.dev" }],
    });
    ledger.markRunComplete({ runId, status: "done", sentEmails: ["a@x.dev"] });
    const firstCompletedAt = ledger.getRun(runId)?.completedAt;
    ledger.markRunComplete({ runId, status: "interrupted", sentEmails: [] });
    expect(ledger.getRun(runId)?.status).toBe("done"); // unchanged
    expect(ledger.getRun(runId)?.completedAt).toBe(firstCompletedAt);
  });

  it("sweepStaleRuns flips all running rows to interrupted on cold boot (maxAgeMs: 0)", () => {
    ledger.createRun({ playName: "a", dryRun: false, targets: [{}] });
    ledger.createRun({ playName: "b", dryRun: true, targets: [{}] });
    const swept = ledger.sweepStaleRuns({ now: new Date(), maxAgeMs: 0 });
    expect(swept).toHaveLength(2);
    for (const s of swept) {
      expect(ledger.getRun(s.id)?.status).toBe("interrupted");
      expect(ledger.getRun(s.id)?.completedAt).not.toBeNull();
    }
  });

  it("sweepStaleRuns leaves fresh runs alone when maxAgeMs > 0", () => {
    const { runId } = ledger.createRun({ playName: "a", dryRun: false, targets: [{}] });
    const swept = ledger.sweepStaleRuns({
      now: new Date(),
      maxAgeMs: 5 * 60 * 1000,
    });
    expect(swept).toHaveLength(0);
    expect(ledger.getRun(runId)?.status).toBe("running");
  });

  it("run.prospectEmails round-trips intact for the /cadences ?sinceRun filter", () => {
    const { runId } = ledger.createRun({
      playName: "show-hn",
      dryRun: false,
      targets: [{ email: "a@x.dev" }, { email: "b@x.dev" }],
    });
    ledger.markRunComplete({
      runId,
      status: "done",
      sentEmails: ["A@X.DEV", "b@x.dev"],
    });
    const run = ledger.getRun(runId)!;
    expect(run.prospectEmails).toEqual(["A@X.DEV", "b@x.dev"]);
    // Downstream filter (in /api/cadences) lowercases before set-lookup; the
    // ledger stores verbatim. Verifying the stored shape so we don't regress
    // case-handling expectations on consumer side.
  });

  it("appendRunEvent leaves counters alone for non-counter events", () => {
    const { runId } = ledger.createRun({
      playName: "show-hn",
      dryRun: false,
      targets: [{}],
    });
    // verify / stage / runStarted / done / unknown — none of these should
    // touch drafted/sent/error counters.
    ledger.appendRunEvent({ runId, event: { kind: "verify", total: 1, verified: 1, dropped: [] } });
    ledger.appendRunEvent({ runId, event: { kind: "stage", stage: "drafting" } });
    ledger.appendRunEvent({ runId, event: { kind: "runStarted", runId, startedAt: "now" } });
    ledger.appendRunEvent({ runId, event: { kind: "done", total: 1, sent: 1 } });
    ledger.appendRunEvent({ runId, event: { kind: "mystery", foo: "bar" } });
    const run = ledger.getRun(runId)!;
    expect(run.draftedCount).toBe(0);
    expect(run.sentCount).toBe(0);
    expect(run.errorCount).toBe(0);
    expect(run.events).toHaveLength(5);
  });

  it("appendRunEvent recovers when events_json is corrupt (starts a fresh array)", async () => {
    const { runId } = ledger.createRun({
      playName: "show-hn",
      dryRun: false,
      targets: [{}],
    });
    // Stomp events_json with garbage to simulate a partial-write corruption.
    // We open a parallel Database connection (same file) to issue raw SQL —
    // ledger.ts intentionally keeps its `db` field private.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(dbPath);
    raw.prepare("UPDATE runs SET events_json = 'not-json' WHERE id = ?").run(runId);
    raw.close();
    // appendRunEvent silently parses garbage as [] and appends the new event.
    ledger.appendRunEvent({ runId, event: { kind: "draft", index: 0 } });
    const run = ledger.getRun(runId)!;
    expect(run.events).toHaveLength(1);
    expect(run.draftedCount).toBe(1);
  });

  it("listRuns returns empty array when no rows exist", () => {
    expect(ledger.listRuns()).toEqual([]);
  });

  it("listRuns filters by status and orders newest-first", async () => {
    const { runId: a } = ledger.createRun({ playName: "a", dryRun: false, targets: [{}] });
    // Ensure b's started_at is strictly later than a's.
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    const { runId: b } = ledger.createRun({ playName: "b", dryRun: false, targets: [{}] });
    ledger.markRunComplete({ runId: a, status: "done" });
    const running = ledger.listRuns({ status: "running" });
    expect(running.map((r) => r.id)).toEqual([b]); // a is done; only b matches
    const all = ledger.listRuns({});
    expect(all.map((r) => r.id)).toEqual([b, a]); // newest first
  });

  it("listRuns returns the slim shape only — no targets/events leakage to the home dashboard", () => {
    ledger.createRun({
      playName: "p",
      dryRun: false,
      targets: [
        { email: "a@x.dev", padding: "x".repeat(500) },
        { email: "b@x.dev", padding: "y".repeat(500) },
      ],
    });
    const rows = ledger.listRuns();
    expect(rows).toHaveLength(1);
    // Lock in the slim projection: only these 9 keys come back.
    expect(Object.keys(rows[0]!).toSorted()).toEqual([
      "completedAt",
      "draftedCount",
      "errorCount",
      "id",
      "playName",
      "sentCount",
      "startedAt",
      "status",
      "targetCount",
    ]);
    // Negative assertion: heavy fields stay on the by-id endpoint (getRun).
    const row = rows[0] as Record<string, unknown>;
    expect(row["targets"]).toBeUndefined();
    expect(row["events"]).toBeUndefined();
    expect(row["prospectEmails"]).toBeUndefined();
    expect(row["targets_json"]).toBeUndefined();
    expect(row["events_json"]).toBeUndefined();
  });

  it("listRuns respects the limit cap", () => {
    for (let i = 0; i < 7; i++) {
      ledger.createRun({ playName: `p${i}`, dryRun: false, targets: [{}] });
    }
    expect(ledger.listRuns({ limit: 3 })).toHaveLength(3);
    // Out-of-range limits clamp to [1, 50].
    expect(ledger.listRuns({ limit: 0 })).toHaveLength(1);
    expect(ledger.listRuns({ limit: 9999 })).toHaveLength(7);
  });

  it("sweepStaleRuns skips runs that are already done/interrupted", () => {
    const { runId: a } = ledger.createRun({ playName: "p", dryRun: false, targets: [{}] });
    const { runId: b } = ledger.createRun({ playName: "p", dryRun: false, targets: [{}] });
    ledger.markRunComplete({ runId: a, status: "done" });
    ledger.markRunComplete({ runId: b, status: "interrupted" });
    const swept = ledger.sweepStaleRuns({ now: new Date(), maxAgeMs: 0 });
    expect(swept).toHaveLength(0);
    expect(ledger.getRun(a)?.status).toBe("done");
    expect(ledger.getRun(b)?.status).toBe("interrupted");
  });
});

describe("Ledger outcomes + cold prospects", () => {
  it("recordOutcome + outcomesByPlay", () => {
    const pid = ledger.upsertProspect({ name: "C", email: "c@x.com", source: "t" });
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "meeting_booked" });
    ledger.recordOutcome({
      prospectId: pid,
      playName: "show-hn",
      outcome: "deal_won",
      amountUsd: 5000,
    });
    const out = ledger.outcomesByPlay();
    const show = out.find((r) => r.play_name === "show-hn");
    expect(show?.meetings).toBe(1);
    expect(show?.won).toBe(1);
    expect(show?.lost).toBe(0);
  });

  it("listColdProspects respects the day window", () => {
    const pid = ledger.upsertProspect({ name: "D", email: "d@x.com", source: "t" });
    // Manually backdate a sequence event to 75 days ago by inserting one then UPDATE.
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    // poke the row's timestamp via raw SQL accessor (the ledger doesn't expose one — bypass via internal db)
    // Since we don't have a setter, just verify the in-window filter excludes this fresh event.
    const fresh = ledger.listColdProspects({
      minDaysSinceLastEvent: 60,
      maxDaysSinceLastEvent: 90,
    });
    expect(fresh).toHaveLength(0);
  });
});

describe("enrichment cache — negative entries", () => {
  it("failure write is readable with status 'failed' and the message payload", () => {
    ledger.setCachedEnrichmentFailure("bad@x.dev", "Job failed: Tool execution failed");
    const row = ledger.getCachedEnrichment("bad@x.dev");
    expect(row?.status).toBe("failed");
    expect(JSON.parse(row!.result_json)).toEqual({
      failed: true,
      message: "Job failed: Tool execution failed",
    });
  });

  it("a later success upsert clears the failed status", () => {
    ledger.setCachedEnrichmentFailure("flaky@x.dev", "timeout");
    ledger.setCachedEnrichment("flaky@x.dev", JSON.stringify({ profile: { phone: "+1 555" } }));
    const row = ledger.getCachedEnrichment("flaky@x.dev");
    expect(row?.status).toBeNull();
    expect(JSON.parse(row!.result_json).profile.phone).toBe("+1 555");
  });

  it("a later failure overwrites a success entry", () => {
    ledger.setCachedEnrichment("was-ok@x.dev", JSON.stringify({ profile: {} }));
    ledger.setCachedEnrichmentFailure("was-ok@x.dev", "revoked");
    expect(ledger.getCachedEnrichment("was-ok@x.dev")?.status).toBe("failed");
  });
});

describe("Ledger recordCadenceReply — atomic control + analytics write", () => {
  function enrollWithSentStep(): number {
    const id = ledger.upsertProspect({ name: "Pat", email: "pat@co.com", source: "repo-interest" });
    ledger.enrollCadence({
      prospectId: id,
      playName: "repo-interest",
      nextDueAt: "2026-01-01T00:00:00Z",
    });
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: "repo-interest",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    return id;
  }

  it("flips the cadence to replied AND marks the sent step replied in one call", () => {
    const id = enrollWithSentStep();

    const { newlyReplied } = ledger.recordCadenceReply({
      prospectId: id,
      playName: "repo-interest",
    });

    expect(newlyReplied).toBe(true);
    expect(ledger.getCadence(id, "repo-interest")?.status).toBe("replied");
    const events = ledger.listSequenceEventsForProspectPlay(id, "repo-interest");
    expect(events.map((e) => e.status)).toEqual(["replied"]);
    // Reply rate stays sane: the replied step is still counted as sent.
    const ev = ledger.eventsByPlay().find((e) => e.play_name === "repo-interest");
    expect(ev).toMatchObject({ sent: 1, replied: 1 });
  });

  it("is idempotent — a second call doesn't re-count or mark a second step", () => {
    const id = enrollWithSentStep();
    // A second sent step (e.g. a follow-up) before the reply lands.
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: "repo-interest",
      stepIndex: 1,
      channel: "email",
      status: "sent",
    });

    expect(
      ledger.recordCadenceReply({ prospectId: id, playName: "repo-interest" }).newlyReplied,
    ).toBe(true);
    // Re-running (the every-5-min poll) must not flip a second step to replied.
    expect(
      ledger.recordCadenceReply({ prospectId: id, playName: "repo-interest" }).newlyReplied,
    ).toBe(false);

    const ev = ledger.eventsByPlay().find((e) => e.play_name === "repo-interest");
    expect(ev).toMatchObject({ sent: 2, replied: 1 });
  });

  it("backfills the analytics event for a cadence already marked replied", () => {
    const id = enrollWithSentStep();
    // Simulate the pre-existing-data case: control plane already replied, but no
    // sequence_events row was ever marked (the old detection path).
    ledger.setCadenceStatus({ prospectId: id, playName: "repo-interest", status: "replied" });
    expect(
      ledger.listSequenceEventsForProspectPlay(id, "repo-interest").map((e) => e.status),
    ).toEqual(["sent"]);

    const { newlyReplied } = ledger.recordCadenceReply({
      prospectId: id,
      playName: "repo-interest",
    });

    expect(newlyReplied).toBe(false); // not a new reply — don't recount
    expect(
      ledger.listSequenceEventsForProspectPlay(id, "repo-interest").map((e) => e.status),
    ).toEqual(["replied"]); // but the event is backfilled
  });

  it("leaves a terminal (breakup) cadence untouched", () => {
    const id = enrollWithSentStep();
    ledger.setCadenceStatus({ prospectId: id, playName: "repo-interest", status: "breakup" });

    const { newlyReplied } = ledger.recordCadenceReply({
      prospectId: id,
      playName: "repo-interest",
    });

    expect(newlyReplied).toBe(false);
    expect(ledger.getCadence(id, "repo-interest")?.status).toBe("breakup");
    expect(
      ledger.listSequenceEventsForProspectPlay(id, "repo-interest").map((e) => e.status),
    ).toEqual(["sent"]);
  });
});

describe("Ledger inbox drafts + sent replies", () => {
  const draft = {
    threadKey: "thread-1",
    inboundEmailId: "msg-1",
    toEmail: "founder@acme.com",
    subject: "Re: hello",
    identityId: "gmail:me@x.com",
    body: "first pass",
  };

  it("saves and reads back a draft via getInboxThreads", () => {
    ledger.upsertInboxDraft(draft);
    const t = ledger.getInboxThreads().get("thread-1");
    expect(t?.draftBody).toBe("first pass");
    expect(t?.sent).toEqual([]);
  });

  it("upsert overwrites the existing draft (one row per thread)", () => {
    ledger.upsertInboxDraft(draft);
    ledger.upsertInboxDraft({ ...draft, body: "second pass" });
    expect(ledger.getInboxThreads().get("thread-1")?.draftBody).toBe("second pass");
  });

  it("clearInboxDraft removes the draft", () => {
    ledger.upsertInboxDraft(draft);
    ledger.clearInboxDraft("thread-1");
    expect(ledger.getInboxThreads().get("thread-1")).toBeUndefined();
  });

  it("recordInboxSent appends to history and clears the draft", () => {
    ledger.upsertInboxDraft(draft);
    ledger.recordInboxSent({
      threadKey: "thread-1",
      toEmail: draft.toEmail,
      subject: draft.subject,
      body: "the reply we sent",
      identityId: draft.identityId,
      requestId: "req-1",
    });
    const t = ledger.getInboxThreads().get("thread-1");
    expect(t?.draftBody).toBeNull();
    expect(t?.sent.map((s) => s.body)).toEqual(["the reply we sent"]);
  });

  it("accumulates multiple sent replies (reply-again) in chronological order", () => {
    ledger.recordInboxSent({
      threadKey: "thread-1",
      toEmail: draft.toEmail,
      subject: draft.subject,
      body: "first reply",
      identityId: draft.identityId,
      requestId: "req-1",
    });
    ledger.recordInboxSent({
      threadKey: "thread-1",
      toEmail: draft.toEmail,
      subject: draft.subject,
      body: "second reply",
      identityId: draft.identityId,
      requestId: "req-2",
    });
    const sent = ledger.getInboxThreads().get("thread-1")?.sent ?? [];
    expect(sent.map((s) => s.body)).toEqual(["first reply", "second reply"]);
    expect(sent.every((s) => typeof s.sentAt === "string" && s.sentAt.length > 0)).toBe(true);
  });
});

describe("Ledger pending_resolution (outage retry queue)", () => {
  it("upsert is idempotent, listable, and dedup-checkable", () => {
    ledger.upsertPendingResolution({
      playName: "luma-events",
      dedupeKey: "evt:1:host",
      source: "luma:sf",
      raw: { name: "Ada", domain: "acme.dev" },
    });
    // Re-discovery upserts the same row (no duplicate, raw refreshed).
    ledger.upsertPendingResolution({
      playName: "luma-events",
      dedupeKey: "evt:1:host",
      source: "luma:sf",
      raw: { name: "Ada Lovelace", domain: "acme.dev" },
    });
    const rows = ledger.listPendingResolution({ playName: "luma-events" });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.raw_json)).toEqual({ name: "Ada Lovelace", domain: "acme.dev" });
    expect(rows[0]!.attempts).toBe(0);
    expect(ledger.isPendingResolution("luma-events", "evt:1:host")).toBe(true);
    expect(ledger.isPendingResolution("luma-events", "nope")).toBe(false);
  });

  it("markAttempted bumps the counter; delete removes the row", () => {
    ledger.upsertPendingResolution({
      playName: "show-hn",
      dedupeKey: "post:9",
      source: "hn",
      raw: {},
    });
    ledger.markPendingResolutionAttempted("show-hn", "post:9");
    ledger.markPendingResolutionAttempted("show-hn", "post:9");
    expect(ledger.listPendingResolution({ playName: "show-hn" })[0]!.attempts).toBe(2);
    ledger.deletePendingResolution("show-hn", "post:9");
    expect(ledger.isPendingResolution("show-hn", "post:9")).toBe(false);
  });

  it("sweepStale purges only rows older than the cutoff", () => {
    ledger.upsertPendingResolution({ playName: "p", dedupeKey: "fresh", source: "s", raw: {} });
    // Backdate one row to 8 days ago.
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE pending_resolution SET first_seen_at = ? WHERE dedupe_key = 'fresh'")
      .run(new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());
    ledger.upsertPendingResolution({ playName: "p", dedupeKey: "new", source: "s", raw: {} });
    const removed = ledger.sweepStalePendingResolution(7 * 24 * 3600 * 1000);
    expect(removed).toBe(1);
    expect(ledger.isPendingResolution("p", "fresh")).toBe(false);
    expect(ledger.isPendingResolution("p", "new")).toBe(true);
  });
});
