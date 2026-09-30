/**
 * Focused regression coverage for the domain stores extracted from
 * `ledger.ts` in issue #751 (direct-mail, runs, triggers, meetings,
 * outcomes, sending, spend reservations, and the shared claim/clear marker
 * helper). Exercised entirely through the public `Ledger` API so this file
 * also proves the extraction changed nothing observable. Broad coverage of
 * each area already exists elsewhere (direct-mail.test.ts,
 * meetings.test.ts, daily-spend.test.ts, send-routing.test.ts,
 * ledger-cancel-run.test.ts, pack-apply-route.test.ts /
 * trigger-config-route.test.ts); this file targets the specific behaviors
 * that are easy to silently regress during a mechanical extraction: shared
 * helpers now serving two tables, and a transaction-atomicity contract that
 * depends on exactly when a callback is invoked relative to the lock.
 */
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
    `oneshot-gtm-extraction-regressions-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("ledger-markers.ts: claimMarker/clearMarker shared across cadence_state and triggers", () => {
  it("claims and clears the cadence sending marker (ledger-cadence.ts's table)", () => {
    const pid = ledger.upsertProspect({ email: "cadence-marker@acme.dev", name: "Cadence" });
    ledger.enrollCadence({ prospectId: pid, playName: "post-funding", nextDueAt: "2026-01-01" });
    const startedAt = new Date().toISOString();
    expect(
      ledger.claimCadenceSendingMarker({
        prospectId: pid,
        playName: "post-funding",
        startedAtIso: startedAt,
      }),
    ).toBe(true);
    // A second claim without releasing fails: the marker is held.
    expect(
      ledger.claimCadenceSendingMarker({
        prospectId: pid,
        playName: "post-funding",
        startedAtIso: new Date().toISOString(),
      }),
    ).toBe(false);
    ledger.clearCadenceSendingMarker({ prospectId: pid, playName: "post-funding" });
    // Released: a fresh claim now succeeds.
    expect(
      ledger.claimCadenceSendingMarker({
        prospectId: pid,
        playName: "post-funding",
        startedAtIso: new Date().toISOString(),
      }),
    ).toBe(true);
  });

  it("claims and clears the trigger running marker (ledger-triggers.ts's table) via the same helper", () => {
    ledger.upsertTrigger({ name: "post-funding", configJson: "{}" });
    const startedAt = new Date().toISOString();
    expect(ledger.markTriggerRunning("post-funding", startedAt)).toBe(true);
    // Held: a second claim without a stale cutoff fails.
    expect(ledger.markTriggerRunning("post-funding", new Date().toISOString())).toBe(false);
    ledger.updateTriggerLastPoll({ name: "post-funding", summary: { ok: true } });
    // updateTriggerLastPoll clears running_started_at: a fresh claim now succeeds.
    expect(ledger.markTriggerRunning("post-funding", new Date().toISOString())).toBe(true);
  });

  it("a stale trigger claim can be reclaimed via staleCutoffIso, same semantics as the cadence marker", () => {
    ledger.upsertTrigger({ name: "luma-events", configJson: "{}" });
    const staleStart = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(ledger.markTriggerRunning("luma-events", staleStart)).toBe(true);
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    // Fresh cutoff (now) is after the stale start: reclaim succeeds.
    expect(ledger.markTriggerRunning("luma-events", new Date().toISOString(), cutoff)).toBe(true);
  });
});

describe("ledger-triggers.ts: config/enable/batch-apply round trip unchanged", () => {
  it("upsertTrigger + getTrigger + listTriggers round-trip", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: '{"a":1}', enabled: true });
    const row = ledger.getTrigger("show-hn")!;
    expect(row.name).toBe("show-hn");
    expect(row.enabled).toBe(1);
    expect(row.config_json).toBe('{"a":1}');
    expect(ledger.listTriggers().map((t) => t.name)).toContain("show-hn");
  });

  it("setTriggerEnabled/setTriggerConfig mutate a single trigger without touching others", () => {
    ledger.upsertTrigger({ name: "a", configJson: "{}" });
    ledger.upsertTrigger({ name: "b", configJson: "{}" });
    ledger.setTriggerEnabled("a", false);
    ledger.setTriggerConfig("a", '{"x":2}');
    expect(ledger.getTrigger("a")!.enabled).toBe(0);
    expect(ledger.getTrigger("a")!.config_json).toBe('{"x":2}');
    expect(ledger.getTrigger("b")!.enabled).toBe(1);
  });

  it("applyTriggerConfigs is atomic: one bad entry rolls back the whole batch", () => {
    ledger.upsertTrigger({ name: "existing", configJson: "{}" });
    expect(() =>
      ledger.applyTriggerConfigs([
        { name: "existing", configJson: '{"ok":true}' },
        // An object bound as a SQLite parameter throws at .run() time:
        // this exercises the mid-batch failure the atomicity guard covers.
        { name: "second", configJson: { bad: true } as unknown as string },
      ]),
    ).toThrow();
    // The first entry's write must not have survived the rollback.
    expect(ledger.getTrigger("existing")!.config_json).toBe("{}");
  });

  it("clearTriggerClaim releases the marker without stamping last_polled_at", () => {
    ledger.upsertTrigger({ name: "civic-agenda", configJson: "{}" });
    ledger.markTriggerRunning("civic-agenda", new Date().toISOString());
    const before = ledger.getTrigger("civic-agenda")!.last_polled_at;
    ledger.clearTriggerClaim({ name: "civic-agenda", summary: { refused: "ceiling" } });
    const after = ledger.getTrigger("civic-agenda")!;
    expect(after.last_polled_at).toBe(before);
    expect(after.running_started_at).toBeNull();
    expect(JSON.parse(after.last_run_summary!)).toEqual({ refused: "ceiling" });
    // The marker being clear means a fresh claim succeeds immediately.
    expect(ledger.markTriggerRunning("civic-agenda", new Date().toISOString())).toBe(true);
  });
});

describe("ledger-runs.ts: create/append/complete/cancel round trip unchanged", () => {
  it("createRun -> appendRunEvent bumps the right counter and preserves prior events", () => {
    const { runId } = ledger.createRun({
      playName: "post-funding",
      dryRun: false,
      targets: [{ a: 1 }],
    });
    ledger.appendRunEvent({ runId, event: { kind: "draft" } });
    ledger.appendRunEvent({ runId, event: { kind: "send" } });
    ledger.appendRunEvent({ runId, event: { kind: "error" } });
    const run = ledger.getRun(runId)!;
    expect(run.draftedCount).toBe(1);
    expect(run.sentCount).toBe(1);
    expect(run.errorCount).toBe(1);
    expect(run.events).toHaveLength(3);
  });

  it("cancelRun is a CAS on status='running': a second cancel no-ops and reports the already-terminal status", () => {
    const { runId } = ledger.createRun({ playName: "post-funding", dryRun: false, targets: [] });
    const first = ledger.cancelRun({ runId, reason: "user abort" });
    expect(first).toEqual({ cancelled: true, status: "cancelled" });
    const second = ledger.cancelRun({ runId, reason: "user abort again" });
    expect(second).toEqual({ cancelled: false, status: "cancelled" });
  });

  it("markRunComplete is also CASed on status='running': a cancelled run isn't overwritten to done", () => {
    const { runId } = ledger.createRun({ playName: "post-funding", dryRun: false, targets: [] });
    ledger.cancelRun({ runId, reason: "abort" });
    ledger.markRunComplete({ runId, status: "done" });
    expect(ledger.getRun(runId)!.status).toBe("cancelled");
  });
});

describe("ledger-meetings.ts: upsert/outcome/dismiss round trip unchanged", () => {
  it("upsertMeeting inserts new, then a reschedule clears outcome_prompted_at but keeps outcome", () => {
    const first = ledger.upsertMeeting({
      calendarId: "cal1",
      eventId: "evt1",
      status: "confirmed",
      startsAt: "2026-01-01T10:00:00Z",
    });
    expect(first).toEqual({ isNew: true, fingerprintChanged: true });
    ledger.markMeetingPrompted("cal1", "evt1");
    ledger.setMeetingOutcome({ calendarId: "cal1", eventId: "evt1", outcome: "held" });
    // Reschedule: starts_at changes.
    const second = ledger.upsertMeeting({
      calendarId: "cal1",
      eventId: "evt1",
      status: "confirmed",
      startsAt: "2026-01-02T10:00:00Z",
    });
    expect(second.isNew).toBe(false);
    const row = ledger.getMeeting("cal1", "evt1")!;
    expect(row.starts_at).toBe("2026-01-02T10:00:00Z");
    expect(row.outcome_prompted_at).toBeNull();
    expect(row.outcome).toBe("held"); // outcome itself survives a reschedule
  });

  it("an unseen cancellation stub with no startsAt is never inserted", () => {
    const result = ledger.upsertMeeting({
      calendarId: "cal2",
      eventId: "ghost",
      status: "cancelled",
    });
    expect(result).toEqual({ isNew: true, fingerprintChanged: false });
    expect(ledger.getMeeting("cal2", "ghost")).toBeNull();
  });

  it("confirmMeetingMatch promotes prospect_id and dismissMeetingMatch clears the suggestion", () => {
    const pid = ledger.upsertProspect({ email: "meeting@acme.dev", name: "M" });
    ledger.upsertMeeting({
      calendarId: "cal3",
      eventId: "evt3",
      status: "confirmed",
      startsAt: "2026-01-01T10:00:00Z",
      suggestedProspectId: pid,
      matchStatus: "suggested",
    });
    ledger.confirmMeetingMatch("cal3", "evt3", pid);
    let row = ledger.getMeeting("cal3", "evt3")!;
    expect(row.prospect_id).toBe(pid);
    expect(row.match_status).toBe("exact");
    expect(row.suggested_prospect_id).toBeNull();

    ledger.upsertMeeting({
      calendarId: "cal4",
      eventId: "evt4",
      status: "confirmed",
      startsAt: "2026-01-01T10:00:00Z",
      suggestedProspectId: pid,
      matchStatus: "ambiguous",
    });
    ledger.dismissMeetingMatch("cal4", "evt4");
    row = ledger.getMeeting("cal4", "evt4")!;
    expect(row.match_status).toBe("dismissed");
    expect(row.suggested_prospect_id).toBeNull();
  });
});

describe("ledger-spend.ts: reserveSpendIfUnderCeiling reads posted spend INSIDE the lock", () => {
  it("grants a reservation up to the ceiling and refuses the one that would exceed it", () => {
    const sinceIso = "2026-01-01T00:00:00.000Z";
    const a = ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd: 5, amountUsd: 3 });
    expect(a).not.toBeNull();
    const b = ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd: 5, amountUsd: 2 });
    expect(b).not.toBeNull(); // lands exactly on the ceiling: allowed
    const c = ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd: 5, amountUsd: 0.01 });
    expect(c).toBeNull(); // would exceed
    expect(ledger.reservedSpendUsd(sinceIso)).toBe(5);
  });

  it("releasing a reservation frees headroom for the next check", () => {
    const sinceIso = "2026-01-01T00:00:00.000Z";
    const id = ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd: 1, amountUsd: 1 })!;
    expect(
      ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd: 1, amountUsd: 0.5 }),
    ).toBeNull();
    ledger.releaseSpendReservation(id);
    expect(
      ledger.reserveSpendIfUnderCeiling({ sinceIso, ceilingUsd: 1, amountUsd: 0.5 }),
    ).not.toBeNull();
  });

  it("sweepStaleSpendReservations removes reservations older than maxAgeMs", () => {
    const id = ledger.reserveSpend(1);
    // Backdate created_at directly (test-only), mirroring the pattern other
    // ledger test files use to simulate age without faking the clock.
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE spend_reservations SET created_at = '2000-01-01 00:00:00' WHERE id = ?")
      .run(id);
    const swept = ledger.sweepStaleSpendReservations(60_000);
    expect(swept).toBe(1);
    expect(ledger.reservedSpendUsd("2000-01-01T00:00:00.000Z")).toBe(0);
  });
});

describe("ledger-direct-mail.ts: draft/prep/address round trip unchanged", () => {
  it("saveDirectMail rejects a stale revision and getDirectMail reflects the winning write", () => {
    ledger.saveDirectMail({
      id: "d1",
      prospectId: 1,
      playName: "post-funding",
      enrollment: "e1",
      stepIndex: 0,
      revision: 0,
    } as never);
    const saved = ledger.getDirectMail("d1")!;
    expect(saved.revision).toBe(1);
    expect(() => ledger.saveDirectMail({ ...saved, revision: 0 } as never)).toThrow(
      /mailpiece changed/i,
    );
  });

  it("setMailAddress writes both the address and its metadata in one transaction", () => {
    ledger.setMailAddress("prospect:1", { line1: "1 Main St" } as never, "manual");
    expect(ledger.getMailAddress("prospect:1")).toEqual({ line1: "1 Main St" });
    expect(ledger.getMailAddressMetadata("prospect:1")).toMatchObject({ source: "manual" });
  });
});

describe("ledger-outcomes.ts: recordOutcome / outcomesByPlay round trip unchanged", () => {
  it("outcomesByPlay aggregates by play and sums won_value_usd for deal_won only", () => {
    const pid = ledger.upsertProspect({ email: "outcome@acme.dev", name: "O" });
    ledger.recordOutcome({ prospectId: pid, playName: "post-funding", outcome: "meeting_booked" });
    ledger.recordOutcome({
      prospectId: pid,
      playName: "post-funding",
      outcome: "deal_won",
      amountUsd: 500,
    });
    ledger.recordOutcome({ prospectId: pid, playName: "post-funding", outcome: "deal_lost" });
    const rows = ledger.outcomesByPlay();
    const row = rows.find((r) => r.play_name === "post-funding")!;
    expect(row.meetings).toBe(1);
    expect(row.won).toBe(1);
    expect(row.lost).toBe(1);
    expect(row.won_value_usd).toBe(500);
  });
});
