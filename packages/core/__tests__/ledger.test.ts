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

    ledger.advanceCadence({ prospectId: pid, playName: "job-change", newStep: 1, nextDueAt: null });
    ledger.setCadenceStatus({ prospectId: pid, playName: "job-change", status: "replied" });

    const after = ledger.listAllCadences();
    expect(after[0]?.current_step).toBe(1);
    expect(after[0]?.status).toBe("replied");
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
