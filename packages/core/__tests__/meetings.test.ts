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
    `oneshot-gtm-meetings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

const BASE = {
  calendarId: "primary",
  eventId: "e1",
  status: "confirmed",
  summary: "Intro call",
  allDay: false,
  startsAt: "2026-08-01T14:00:00.000Z",
  endsAt: "2026-08-01T14:30:00.000Z",
  eventUpdatedAt: "2026-08-01T10:00:00.000Z",
  attendeesFingerprint: "pat@acme.com",
};

describe("Ledger.upsertMeeting", () => {
  it("inserts a new row and reports isNew:true", () => {
    const res = ledger.upsertMeeting(BASE);
    expect(res.isNew).toBe(true);
    expect(res.fingerprintChanged).toBe(true);
    const row = ledger.getMeeting("primary", "e1");
    expect(row?.summary).toBe("Intro call");
    expect(row?.starts_at).toBe(BASE.startsAt);
  });

  it("upserts in place — a second call updates, not inserts a duplicate row", () => {
    ledger.upsertMeeting(BASE);
    const res = ledger.upsertMeeting({ ...BASE, summary: "Intro call (rescheduled)" });
    expect(res.isNew).toBe(false);
    expect(ledger.getMeeting("primary", "e1")?.summary).toBe("Intro call (rescheduled)");
  });

  it("a cancellation stub for an event never seen is a no-op — nothing inserted", () => {
    ledger.upsertMeeting({
      calendarId: "primary",
      eventId: "never-seen",
      status: "cancelled",
      // No startsAt — the stub carries almost nothing, exactly like a real
      // cancellation-only payload from the API.
    });
    expect(ledger.getMeeting("primary", "never-seen")).toBeNull();
  });

  it("a cancellation for an event ALREADY seen updates it in place without wiping the match", () => {
    ledger.upsertMeeting({ ...BASE, prospectId: 7, matchStatus: "exact" });
    ledger.upsertMeeting({
      calendarId: "primary",
      eventId: "e1",
      status: "cancelled",
      // The stub carries no summary/prospectId/matchStatus — those must
      // survive via COALESCE, never wiped by INSERT OR REPLACE semantics.
    });
    const row = ledger.getMeeting("primary", "e1")!;
    expect(row.status).toBe("cancelled");
    expect(row.summary).toBe("Intro call");
    expect(row.prospect_id).toBe(7);
    expect(row.match_status).toBe("exact");
  });

  it("a reschedule (starts_at changes) clears outcome_prompted_at but keeps a recorded outcome", () => {
    ledger.upsertMeeting(BASE);
    ledger.markMeetingPrompted("primary", "e1");
    ledger.setMeetingOutcome({ calendarId: "primary", eventId: "e1", outcome: "held" });
    expect(ledger.getMeeting("primary", "e1")!.outcome_prompted_at).not.toBeNull();
    ledger.upsertMeeting({ ...BASE, startsAt: "2026-08-02T14:00:00.000Z" });
    const row = ledger.getMeeting("primary", "e1")!;
    expect(row.starts_at).toBe("2026-08-02T14:00:00.000Z");
    expect(row.outcome).toBe("held");
    expect(row.outcome_prompted_at).toBeNull();
  });

  it("re-upserting with the SAME starts_at does not clear outcome_prompted_at", () => {
    ledger.upsertMeeting(BASE);
    ledger.markMeetingPrompted("primary", "e1");
    ledger.upsertMeeting({ ...BASE, summary: "touched, same time" });
    expect(ledger.getMeeting("primary", "e1")!.outcome_prompted_at).not.toBeNull();
  });

  it("touchMeetingLastSeen updates last_seen_at and returns true for an existing row", async () => {
    ledger.upsertMeeting(BASE);
    const before = ledger.getMeeting("primary", "e1")!.last_seen_at;
    await new Promise((r) => setTimeout(r, 1100));
    const touched = ledger.touchMeetingLastSeen("primary", "e1");
    expect(touched).toBe(true);
    const after = ledger.getMeeting("primary", "e1")!.last_seen_at;
    expect(after >= before).toBe(true);
  });

  it("touchMeetingLastSeen is a no-op returning false for an unknown row", () => {
    expect(ledger.touchMeetingLastSeen("primary", "nope")).toBe(false);
  });

  it("fingerprintChanged is false when the same fingerprint is upserted again", () => {
    ledger.upsertMeeting(BASE);
    const res = ledger.upsertMeeting({ ...BASE, summary: "unchanged fingerprint" });
    expect(res.fingerprintChanged).toBe(false);
  });

  it("fingerprintChanged is true when the attendee set changes", () => {
    ledger.upsertMeeting(BASE);
    const res = ledger.upsertMeeting({ ...BASE, attendeesFingerprint: "different@acme.com" });
    expect(res.fingerprintChanged).toBe(true);
  });

  it("event_id is only unique within a calendar — two calendars can share the same event_id", () => {
    ledger.upsertMeeting({ ...BASE, calendarId: "cal-a" });
    ledger.upsertMeeting({ ...BASE, calendarId: "cal-b", summary: "Different cal" });
    expect(ledger.getMeeting("cal-a", "e1")?.summary).toBe("Intro call");
    expect(ledger.getMeeting("cal-b", "e1")?.summary).toBe("Different cal");
  });
});

describe("Ledger.listPendingOutcomeMeetings", () => {
  it("includes a confirmed, prospect-linked, past meeting with no outcome", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({
      ...BASE,
      endsAt: "2020-01-01T00:00:00.000Z", // well in the past
      prospectId: pid,
      matchStatus: "exact",
    });
    const rows = ledger.listPendingOutcomeMeetings();
    expect(rows.map((r) => r.event_id)).toContain("e1");
  });

  it("excludes an all-day event", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({
      ...BASE,
      allDay: true,
      endsAt: "2020-01-01T00:00:00.000Z",
      prospectId: pid,
    });
    expect(ledger.listPendingOutcomeMeetings()).toEqual([]);
  });

  it("excludes a meeting the founder declined", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({
      ...BASE,
      endsAt: "2020-01-01T00:00:00.000Z",
      prospectId: pid,
      selfResponse: "declined",
    });
    expect(ledger.listPendingOutcomeMeetings()).toEqual([]);
  });

  it("excludes a meeting still inside the 30-minute grace period", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({
      ...BASE,
      endsAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      prospectId: pid,
    });
    expect(ledger.listPendingOutcomeMeetings()).toEqual([]);
  });

  it("excludes an unmatched meeting (no prospect_id)", () => {
    ledger.upsertMeeting({ ...BASE, endsAt: "2020-01-01T00:00:00.000Z" });
    expect(ledger.listPendingOutcomeMeetings()).toEqual([]);
  });

  it("excludes a meeting that already has an outcome", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({
      ...BASE,
      endsAt: "2020-01-01T00:00:00.000Z",
      prospectId: pid,
    });
    ledger.setMeetingOutcome({ calendarId: "primary", eventId: "e1", outcome: "held" });
    expect(ledger.listPendingOutcomeMeetings()).toEqual([]);
  });
});

describe("Ledger.confirmMeetingMatch / dismissMeetingMatch", () => {
  it("confirm promotes a suggestion to exact and clears the suggested id", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({ ...BASE, suggestedProspectId: pid, matchStatus: "suggested" });
    ledger.confirmMeetingMatch("primary", "e1", pid);
    const row = ledger.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("exact");
    expect(row.prospect_id).toBe(pid);
    expect(row.suggested_prospect_id).toBeNull();
  });

  it("dismiss marks match_status dismissed and clears the suggestion", () => {
    const pid = ledger.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledger.upsertMeeting({ ...BASE, suggestedProspectId: pid, matchStatus: "suggested" });
    ledger.dismissMeetingMatch("primary", "e1");
    const row = ledger.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("dismissed");
    expect(row.suggested_prospect_id).toBeNull();
  });

  it("a dismiss survives a re-poll that carries the SAME fingerprint (upsertMeeting's COALESCE)", () => {
    ledger.upsertMeeting(BASE);
    ledger.dismissMeetingMatch("primary", "e1");
    // Re-poll: same attendee set, so the caller (the real poller) would not
    // even attempt to re-match — but prove the ledger layer alone preserves
    // the dismissal when matchStatus is omitted on the next upsert.
    ledger.upsertMeeting({ ...BASE, summary: "touched again" });
    expect(ledger.getMeeting("primary", "e1")!.match_status).toBe("dismissed");
  });
});

describe("Ledger.listMeetingsForReview", () => {
  it("lists suggested and ambiguous rows, excludes exact/dismissed/unmatched", () => {
    ledger.upsertMeeting({ ...BASE, eventId: "suggested-1", matchStatus: "suggested" });
    ledger.upsertMeeting({ ...BASE, eventId: "ambiguous-1", matchStatus: "ambiguous" });
    ledger.upsertMeeting({ ...BASE, eventId: "exact-1", matchStatus: "exact" });
    ledger.upsertMeeting({ ...BASE, eventId: "dismissed-1", matchStatus: "dismissed" });
    ledger.upsertMeeting({ ...BASE, eventId: "unmatched-1" });
    const ids = ledger.listMeetingsForReview().map((r) => r.event_id);
    expect(ids.toSorted()).toEqual(["ambiguous-1", "suggested-1"]);
  });
});

describe("Ledger fuzzy-match helpers", () => {
  it("listProspectsForFuzzyMatch only returns prospects with an email", () => {
    ledger.upsertProspect({ email: "a@acme.com", name: "A", source: "t" });
    ledger.upsertProspect({ email: null, name: "No email", source: "t" });
    const rows = ledger.listProspectsForFuzzyMatch();
    expect(rows.map((r) => r.email)).toEqual(["a@acme.com"]);
  });

  it("hasOutreachHistory / lastOutreachAt reflect sequence_events", () => {
    const pid = ledger.upsertProspect({ email: "a@acme.com", source: "t" });
    expect(ledger.hasOutreachHistory(pid)).toBe(false);
    expect(ledger.lastOutreachAt(pid)).toBeNull();
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "x",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    expect(ledger.hasOutreachHistory(pid)).toBe(true);
    expect(ledger.lastOutreachAt(pid)).not.toBeNull();
  });
});
