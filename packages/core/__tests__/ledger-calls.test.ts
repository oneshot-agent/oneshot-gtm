import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { LEDGER_SCHEMA_VERSION } from "../src/ledger-schema.ts";
import { callsOf, DEFAULT_CALL_HOLD_DAYS } from "../src/config.ts";
import { callReplyIntent } from "../src/ledger-calls.ts";
import { isProspectOptedOut } from "../src/contact-optout.ts";

const phone = (n: number) => `+1512653${String(1000 + n)}`;
const score = (total: number) => ({
  version: "heuristic-v2" as const,
  total,
  components: {
    personFit: 0,
    accountFit: 0,
    intentStrength: 0,
    timingFreshness: 0,
    signalConfidence: 0,
    contactability: 0,
  },
  reasons: [],
  finder: "p",
  scoredAt: "2026-11-01T00:00:00Z",
});

describe("callsOf", () => {
  it("is off with the defaults when unset", () => {
    expect(callsOf({})).toEqual({
      enabled: false,
      cadenceStep: null,
      window: { start: "09:00", end: "17:00", weekdays: true },
      // Absent = the defaults: the keys decide whether it can dial.
      bridge: { provider: "twilio", record: "ask", transcriptionServiceSid: null },
    });
  });

  it("records only on a press unless set to always or off; the legacy true asks", () => {
    const mode = (record: unknown) =>
      callsOf({ calls: { bridge: { provider: "twilio", record } } }).bridge?.record;
    expect([mode("always"), mode("ask"), mode(true), mode(false), mode("yes")]).toEqual([
      "always",
      "ask",
      "ask",
      false,
      "ask",
    ]);
  });

  it("reads a full config and fills holdDays", () => {
    expect(
      callsOf({
        calls: {
          enabled: true,
          cadenceStep: { position: 3, delayDays: 2 },
          window: { start: "10:00", end: "16:30", weekdays: false },
          bridge: { provider: "twilio", record: false, transcriptionServiceSid: " GA1 " },
        },
      }),
    ).toEqual({
      enabled: true,
      cadenceStep: { position: 3, delayDays: 2, holdDays: DEFAULT_CALL_HOLD_DAYS },
      window: { start: "10:00", end: "16:30", weekdays: false },
      bridge: { provider: "twilio", record: false, transcriptionServiceSid: "GA1" },
    });
  });

  it("drops what it cannot use", () => {
    const out = callsOf({
      calls: {
        enabled: "yes",
        cadenceStep: { position: 1, delayDays: 2 },
        window: { start: "17:00", end: "09:00" },
        bridge: { provider: "other" },
      },
    });
    expect(out.enabled).toBe(false);
    expect(out.cadenceStep).toBeNull();
    expect(out.window).toEqual({ start: "09:00", end: "17:00", weekdays: true });
    expect(out.bridge).toBeNull();
    expect(callsOf({ calls: { enabled: true, bridge: null } }).bridge).toBeNull();
  });

  it("drops a step delay past a year and falls back from a hold past one", () => {
    const step = (cadenceStep: Record<string, number>) =>
      callsOf({ calls: { enabled: true, cadenceStep } }).cadenceStep;
    expect(step({ position: 3, delayDays: 365, holdDays: 365 })).toEqual({
      position: 3,
      delayDays: 365,
      holdDays: 365,
    });
    expect(step({ position: 3, delayDays: 366 })).toBeNull();
    expect(step({ position: 3, delayDays: 2, holdDays: 1e9 })?.holdDays).toBe(
      DEFAULT_CALL_HOLD_DAYS,
    );
  });
});

describe("callReplyIntent", () => {
  it("maps outcomes onto the reply labels where they mean the same", () => {
    expect(callReplyIntent("interested")).toBe("interested");
    expect(callReplyIntent("meeting_booked")).toBe("meeting");
    expect(callReplyIntent("not_now")).toBe("not_now");
    expect(callReplyIntent("not_interested")).toBe("not_interested");
    expect(callReplyIntent("wrong_person")).toBe("wrong_person");
    expect(callReplyIntent("do_not_contact")).toBe("unsubscribe");
    expect(callReplyIntent("no_answer")).toBeNull();
  });
});

describe("migration v27", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(tmpdir(), `oneshot-gtm-test-calls-${Date.now()}-${Math.random()}.sqlite`);
  });
  afterEach(() => {
    for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
  });

  it("adds the calls and call_briefs tables to a v26 ledger", () => {
    new Ledger(dbPath).close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE calls; DROP TABLE call_briefs; PRAGMA user_version = 26");
    raw.close();
    new Ledger(dbPath).close();
    const db = new Database(dbPath);
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
        LEDGER_SCHEMA_VERSION,
      );
      const cols = (db.query("PRAGMA table_info(calls)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toEqual(
        expect.arrayContaining([
          "id",
          "prospect_id",
          "play_name",
          "started_at",
          "duration_sec",
          "outcome",
          "note",
          "provider",
          "provider_call_sid",
          "recording_sid",
          "transcript_status",
          "transcript_json",
          "summary_json",
          "created_at",
        ]),
      );
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name='call_briefs'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe("ledger calls", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => ledger.close());

  it("phoneForCall reads the prospect's phone, then the queue row's payload phone", () => {
    const own = ledger.upsertProspect({ name: "Own", email: "own@a.test", phone: "+15126531187" });
    expect(ledger.phoneForCall(own).phone).toBe("+15126531187");
    const queued = ledger.upsertProspect({ name: "Queued", email: "q@a.test" });
    const qid = ledger.enqueueTarget({
      playName: "p",
      payload: { email: "q@a.test", phone: "(512) 653-1187" },
      dedupeKey: "q",
      source: "s",
    })!;
    // Matched by email before the row is linked to the prospect.
    expect(ledger.phoneForCall(queued)).toEqual({
      phone: "+15126531187",
      raw: "(512) 653-1187",
      queueId: qid,
    });
    ledger.setQueueProspectId(qid, queued);
    expect(ledger.phoneForCall(queued).queueId).toBe(qid);
    const junk = ledger.upsertProspect({ name: "Junk", email: "j@a.test", phone: "n/a" });
    expect(ledger.phoneForCall(junk).phone).toBeNull();
  });

  it("never offers a number a call was logged wrong_number on", () => {
    const id = ledger.upsertProspect({ name: "W", email: "w@a.test", phone: "+15126531187" });
    ledger.insertCall({
      prospectId: id,
      startedAt: new Date().toISOString(),
      outcome: "wrong_number",
      phone: "+15126531187",
    });
    expect(ledger.phoneForCall(id).phone).toBeNull();
  });

  it("a call logged do_not_contact blocks every channel", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@a.test", phone: "+15126531187" });
    expect(ledger.callAllowed(id)).toBe(true);
    ledger.insertCall({
      prospectId: id,
      startedAt: new Date().toISOString(),
      outcome: "do_not_contact",
    });
    expect(ledger.callAllowed(id)).toBe(false);
    expect(isProspectOptedOut((ledger as unknown as { db: Database }).db, id)).toBe(true);
  });

  it("a cadence stopped as do-not-contact blocks the call, alone and in a batch", () => {
    const id = ledger.upsertProspect({ name: "S", email: "s@a.test", phone: "+15126531187" });
    const other = ledger.upsertProspect({ name: "T", email: "t@a.test", phone: "+15126531188" });
    const db = (ledger as unknown as { db: Database }).db;
    db.prepare(
      `INSERT INTO cadence_state (prospect_id, play_name, status, stop_reason, current_step, enrolled_at)
       VALUES (?, 'p', 'stopped', 'do_not_contact', 0, datetime('now'))`,
    ).run(id);
    expect(ledger.callAllowed(id)).toBe(false);
    expect([...ledger.callAllowedIds([id, other])]).toEqual([other]);
  });

  it("lists calls newest first and the last call per prospect", () => {
    const id = ledger.upsertProspect({ name: "L", email: "l@a.test" });
    ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-01T10:00:00.000Z",
      outcome: "no_answer",
    });
    const second = ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-02T10:00:00.000Z",
      outcome: "voicemail",
      note: "left a message",
    });
    const calls = ledger.listCallsForProspect(id);
    expect(calls.map((c) => c.outcome)).toEqual(["voicemail", "no_answer"]);
    expect(calls[0]).toMatchObject({ id: second, provider: "tel", transcriptStatus: "none" });
    expect(ledger.lastCallsFor([id]).get(id)).toEqual({
      outcome: "voicemail",
      at: "2026-11-02T10:00:00.000Z",
    });
  });

  it("caches an on-demand brief per prospect", () => {
    const id = ledger.upsertProspect({ name: "B", email: "b@a.test" });
    expect(ledger.getCallBrief(id)).toBeNull();
    const brief = {
      opener: "o",
      offer: "x",
      questions: [],
      objections: [],
      voicemail: "v",
      gatekeeper: null,
    };
    ledger.saveCallBrief({ prospectId: id, playName: null, brief });
    ledger.saveCallBrief({ prospectId: id, playName: "p", brief: { ...brief, offer: "y" } });
    expect(ledger.getCallBrief(id)).toMatchObject({ playName: "p", brief: { offer: "y" } });
  });

  describe("listCallCandidates", () => {
    it("gates opted-out, off-ICP, meeting-held and no-number people", () => {
      const ok = ledger.upsertProspect({ name: "Ok", email: "ok@a.test", phone: phone(1) });
      ledger.upsertProspect({ name: "No number", email: "none@a.test" });
      const offIcp = ledger.upsertProspect({ name: "Off", email: "off@a.test", phone: phone(2) });
      ledger.setProspectIcpVerdict(offIcp, "reject", "wrong role");
      const met = ledger.upsertProspect({ name: "Met", email: "met@a.test", phone: phone(3) });
      ledger.upsertMeeting({
        calendarId: "c",
        eventId: "e",
        status: "confirmed",
        prospectId: met,
        startsAt: "2026-11-01T10:00:00Z",
      });
      ledger.setMeetingOutcome({ calendarId: "c", eventId: "e", outcome: "held" });
      const dnc = ledger.upsertProspect({ name: "Dnc", email: "dnc@a.test", phone: phone(4) });
      ledger.insertCall({
        prospectId: dnc,
        startedAt: new Date().toISOString(),
        outcome: "do_not_contact",
      });
      const ids = ledger.listCallCandidates({ limit: 50 }).map((c) => c.prospectId);
      expect(ids).toEqual([ok]);
    });

    it("ranks a positive reply, then LinkedIn connected, then a live cadence by priority, then the rest", () => {
      const rest = ledger.upsertProspect({ name: "Rest", email: "r@a.test", phone: phone(1) });
      const low = ledger.upsertProspect({ name: "Low", email: "low@a.test", phone: phone(2) });
      const high = ledger.upsertProspect({ name: "High", email: "high@a.test", phone: phone(3) });
      const connected = ledger.upsertProspect({ name: "Con", email: "c@a.test", phone: phone(4) });
      const replied = ledger.upsertProspect({ name: "Rep", email: "rep@a.test", phone: phone(5) });
      for (const [id, total] of [
        [low, 20],
        [high, 80],
      ] as const) {
        const q = ledger.enqueueTarget({
          playName: "p",
          payload: {},
          dedupeKey: `k${id}`,
          source: "s",
          priority: score(total),
        })!;
        ledger.enrollCadence({
          prospectId: id,
          playName: "p",
          nextDueAt: new Date(Date.now() + 86_400_000).toISOString(),
          queueId: q,
        });
      }
      ledger.recordSequenceEvent({
        prospectId: connected,
        playName: "p",
        stepIndex: 0,
        channel: "linkedin",
        status: "sent",
        metadata: { kind: "linkedin_invite", acceptedAt: "2026-11-01T00:00:00Z" },
      });
      ledger.recordInboxReply({
        id: "r1",
        threadKey: "t",
        prospectId: replied,
        fromEmail: "rep@a.test",
        body: "sounds good",
        receivedAt: "2026-11-01T00:00:00Z",
      });
      ledger.setInboxReplyIntent("r1", "interested", null);
      const rows = ledger.listCallCandidates({ limit: 50 });
      expect(rows.map((r) => r.prospectId)).toEqual([replied, connected, high, low, rest]);
      expect(rows.map((r) => r.tier)).toEqual([1, 2, 3, 3, 4]);
      expect(rows[0]!.replyIntent).toBe("interested");
      expect(rows[2]).toMatchObject({ priority: 80, playName: "p" });
      // Excluded ids (the due section's) are left out.
      expect(
        ledger.listCallCandidates({ limit: 50, excludeProspectIds: [replied] })[0]!.prospectId,
      ).toBe(connected);
    });
  });
});

describe("ledger calls: review fixes", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => ledger.close());

  it("the email send backstop refuses a person who said do not contact on a call", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@a.test" });
    expect(ledger.contactSuppressionFor("d@a.test")).toBeNull();
    ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-17T10:00:00.000Z",
      outcome: "no_answer",
    });
    expect(ledger.contactSuppressionFor("d@a.test")).toBeNull();
    ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-17T11:00:00.000Z",
      outcome: "do_not_contact",
    });
    expect(ledger.contactSuppressionFor("D@A.test")).toEqual({
      kind: "unsubscribe",
      received_at: "2026-11-17T11:00:00.000Z",
    });
  });

  it("reads wrong numbers in the workspace's country", () => {
    const id = ledger.upsertProspect({ name: "G", email: "g@a.test", phone: "+442079460958" });
    ledger.insertCall({
      prospectId: id,
      startedAt: new Date().toISOString(),
      outcome: "wrong_number",
      phone: "020 7946 0958",
    });
    expect(ledger.phoneForCall(id, "GB").phone).toBeNull();
  });

  it("the call list takes a phone from a queue row matched by address when none is linked", () => {
    const id = ledger.upsertProspect({ name: "Q", email: "Q@a.test" });
    const qid = ledger.enqueueTarget({
      playName: "p",
      payload: { email: "q@a.test", phone: "(512) 653-1187" },
      dedupeKey: "q",
      source: "s",
    })!;
    expect(ledger.listCallCandidates({ limit: 10 })).toMatchObject([
      { prospectId: id, queuePhone: "(512) 653-1187", queueId: qid },
    ]);
    // A linked row wins, even without a phone (as phoneSourcesFor reads it).
    const linked = ledger.enqueueTarget({
      playName: "p",
      payload: { email: "q@a.test" },
      dedupeKey: "q2",
      source: "s",
    })!;
    ledger.setQueueProspectId(linked, id);
    expect(ledger.listCallCandidates({ limit: 10 })).toEqual([]);
  });

  it("pages through the ranked list", () => {
    const ids = [1, 2, 3].map((n) =>
      ledger.upsertProspect({ name: `P${n}`, email: `p${n}@a.test`, phone: phone(n) }),
    );
    const all = ledger.listCallCandidates({ limit: 10 }).map((c) => c.prospectId);
    expect(all.toSorted()).toEqual(ids.toSorted());
    expect(ledger.listCallCandidates({ limit: 2, offset: 2 }).map((c) => c.prospectId)).toEqual([
      all[2],
    ]);
  });

  it("a stored preview is refused once the cadence moved on", () => {
    const id = ledger.upsertProspect({ name: "C", email: "c@a.test" });
    ledger.enrollCadence({ prospectId: id, playName: "p", nextDueAt: new Date().toISOString() });
    const c = ledger.getCadence(id, "p")!;
    const draft = { subject: "s", body: "b", flags: [], payload: { kind: "email" } };
    const expect0 = { currentStep: c.current_step, enrolledAt: c.enrolled_at };
    expect(ledger.setCadenceDraft({ prospectId: id, playName: "p", draft, expect: expect0 })).toBe(
      true,
    );
    ledger.advanceCadence({ prospectId: id, playName: "p", newStep: 1, nextDueAt: null });
    expect(ledger.setCadenceDraft({ prospectId: id, playName: "p", draft, expect: expect0 })).toBe(
      false,
    );
    expect(ledger.getCadenceDraft({ prospectId: id, playName: "p" })).toBeNull();
  });

  it("takes a queue row's phone matched by a whitespace-padded address", () => {
    const id = ledger.upsertProspect({ name: "Q", email: "q@a.test" });
    const qid = ledger.enqueueTarget({
      playName: "p",
      payload: { email: " Q@a.test ", phone: "(512) 653-1187" },
      dedupeKey: "q",
      source: "s",
    })!;
    expect(ledger.phoneForCall(id)).toEqual({
      phone: "+15126531187",
      raw: "(512) 653-1187",
      queueId: qid,
    });
  });

  it("never logs over a call's do_not_contact outcome", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@a.test", phone: phone(1) });
    const callId = ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-17T10:00:00.000Z",
      outcome: "do_not_contact",
    });
    expect(ledger.setCallOutcome({ id: callId, prospectId: id, outcome: "interested" })).toBe(
      false,
    );
    expect(ledger.getCall(callId)!.outcome).toBe("do_not_contact");
    expect(ledger.callAllowed(id)).toBe(false);
    expect(ledger.listCallCandidates({ limit: 10 })).toEqual([]);
    // The same outcome again is a re-log, not a change.
    expect(
      ledger.setCallOutcome({ id: callId, prospectId: id, outcome: "do_not_contact", note: "n" }),
    ).toBe(true);
    expect(ledger.getCall(callId)!.note).toBe("n");
  });

  it("tier 1 follows the latest answer, by email or on a call", () => {
    const id = ledger.upsertProspect({ name: "R", email: "r@a.test", phone: phone(1) });
    const tier = () => ledger.listCallCandidates({ limit: 10 })[0]!.tier;
    ledger.recordInboxReply({
      id: "r1",
      threadKey: "t",
      prospectId: id,
      fromEmail: "r@a.test",
      body: "sounds good",
      receivedAt: "2026-11-01T00:00:00Z",
    });
    ledger.setInboxReplyIntent("r1", "interested", null);
    expect(tier()).toBe(1);
    // A call after it, logged not interested, ends it.
    ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-02T00:00:00.000Z",
      outcome: "not_interested",
    });
    expect(tier()).toBe(4);
    // A neutral answer later (an auto-reply) leaves it where it stands.
    ledger.recordInboxReply({
      id: "r2",
      threadKey: "t",
      prospectId: id,
      fromEmail: "r@a.test",
      body: "out of office",
      receivedAt: "2026-11-03T00:00:00Z",
    });
    ledger.setInboxReplyIntent("r2", "auto_reply", null);
    expect(tier()).toBe(4);
    // A later call logged interested brings it back.
    ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-04T00:00:00.000Z",
      outcome: "interested",
    });
    expect(ledger.listCallCandidates({ limit: 10 })[0]).toMatchObject({
      tier: 1,
      replyIntent: "interested",
    });
  });

  it("matches a queue row's founderEmail when it has no email, in phoneForCall and the call list", () => {
    const id = ledger.upsertProspect({ name: "F", email: "f@a.test" });
    const qid = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { founderEmail: " F@a.test ", phone: "(512) 653-1187" },
      dedupeKey: "f",
      source: "s",
    })!;
    expect(ledger.phoneForCall(id)).toEqual({
      phone: "+15126531187",
      raw: "(512) 653-1187",
      queueId: qid,
    });
    expect(ledger.listCallCandidates({ limit: 10 })).toMatchObject([
      { prospectId: id, queuePhone: "(512) 653-1187", queueId: qid },
    ]);
  });

  it("a meeting cancelled on the calendar does not count as booked", () => {
    const id = ledger.upsertProspect({ name: "M", email: "m@a.test", phone: phone(1) });
    ledger.recordInboxReply({
      id: "m1",
      threadKey: "t",
      prospectId: id,
      fromEmail: "m@a.test",
      body: "let's talk",
      receivedAt: "2026-11-01T00:00:00Z",
    });
    ledger.setInboxReplyIntent("m1", "interested", null);
    const db = (ledger as unknown as { db: Database }).db;
    const meeting = (eventId: string, status: string) =>
      db
        .prepare(
          `INSERT INTO meetings (calendar_id, event_id, status, starts_at, ends_at, prospect_id)
           VALUES ('c', ?, ?, '2026-12-01T10:00:00Z', '2026-12-01T10:30:00Z', ?)`,
        )
        .run(eventId, status, id);
    const tier = () => ledger.listCallCandidates({ limit: 10 })[0]!.tier;
    meeting("e1", "cancelled");
    expect(tier()).toBe(1);
    // A confirmed upcoming meeting is booked.
    meeting("e2", "confirmed");
    expect(tier()).toBe(4);
  });

  it("the call list takes the newest unlinked queue row by address, as phoneForCall does", () => {
    const id = ledger.upsertProspect({ name: "N", email: "n@a.test" });
    ledger.enqueueTarget({
      playName: "p",
      payload: { email: "n@a.test", phone: "(512) 653-1187" },
      dedupeKey: "n1",
      source: "s",
    });
    // A newer row for the same address, with no phone: the Find phone button's.
    const newest = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { founderEmail: "n@a.test" },
      dedupeKey: "n2",
      source: "s",
    })!;
    expect(ledger.phoneForCall(id)).toMatchObject({ phone: "+15126531187", queueId: newest });
    expect(ledger.listCallCandidates({ limit: 10 })).toMatchObject([
      { prospectId: id, queuePhone: "(512) 653-1187", queueId: newest },
    ]);
  });
});
