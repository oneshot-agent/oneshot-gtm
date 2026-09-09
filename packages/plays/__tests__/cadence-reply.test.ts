import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the reply-detection block of advanceCadence (inbox poll → match
// from-address to a prospect → mark the cadence `replied` → next step is
// skipped). The previously-untested path that decides whether the tool keeps
// emailing someone who already replied.

const calls = { sendEmail: 0 };
let inboxEmails: Array<{
  id?: string;
  from: string;
  subject: string;
  received_at?: string;
  body?: string;
  auto_submitted?: boolean;
}> = [];
let lookupArgs: string[] = [];
let listInboxArgs: Array<Record<string, unknown>> = [];
let failedSources: string[] = [];
// (prospectId, playName) pairs whose sequence_events row flipped to `replied` this run.
let repliedSteps: Array<{ prospectId: number; playName: string }> = [];
// repliedAt values passed to the stub's recordProspectReply, in call order —
// lets tests assert the poll threads the inbound email's own timestamp
// through rather than defaulting to "now" (see markLatestStepReplied).
let recordProspectReplyRepliedAts: Array<string | null | undefined> = [];
// The play behind the prospect's latest sent step — the no-cadence-row fallback.
let latestSentPlay: string | null = null;
// v21 inbox_replies rows captured by the poll (id-keyed, INSERT OR IGNORE semantics).
let persistedReplies: Array<{ id: string; kind?: string | null }> = [];
// Audit-trail sequence events recorded outside recordProspectReply (bounced/unsubscribed).
let seqEvents: Array<{
  prospectId: number;
  playName: string;
  status: string;
  bouncedAt?: string;
}> = [];
// Persisted intent classifications (issue #558): keyed by reply id, mirrors
// the real ledger's inbox_replies.intent column that setInboxReplyIntent
// writes and listInboxReplyIntents reads back.
let intents: Map<string, { intent: string | null; intentReason: string | null }> = new Map();
// Persisted poll_state rows (watermark + backlog), as the real ledger holds them.
let pollState: Record<string, string> = {};
const watermarkOf = () => pollState["inbox_replies"] ?? null;
// Prospect ids for which the angle-refresh hook (issue #357) fired.
let angleRefreshCalls: number[] = [];

type Row = {
  prospect_id: number;
  play_name: string;
  status: string;
  next_due_at: string | null;
  prospect_email: string | null;
};
let rows: Row[] = [];

// Stub ledger mirrors the REAL ledger's case-insensitive lookup: it canonicalizes
// the arg the same way ledger.findProspectByEmail now does, so a prospect stored
// lowercase is found from any-cased inbound address.
const STORED_EMAIL = "sophia@agenticarchitect.ai";

const notifySlackReplyReceivedMock = vi.fn(async () => {});
const notifySlackBounceRecordedMock = vi.fn(async () => {});

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ founderName: "J", productOneLiner: "thing" }),
    notifySlackReplyReceived: notifySlackReplyReceivedMock,
    notifySlackBounceRecorded: notifySlackBounceRecordedMock,
    sendEmail: async () => {
      calls.sendEmail++;
      return { receiptId: 1 };
    },
    triggerAngleRefresh: (prospectId: number) => {
      angleRefreshCalls.push(prospectId);
    },
    // A faithful fake of listInbox's contract: filter `inboxEmails` by
    // since/until on received_at, newest first, clamp to `limit`, has_more
    // when the clamp dropped rows. Emails without received_at pass every
    // filter (the older tests never set one).
    listInbox: async (opts: { since?: string; until?: string; limit?: number }) => {
      listInboxArgs.push(opts);
      const pool = inboxEmails
        .map((e, i) => ({ id: e.id ?? `m${i}`, ...e }))
        .filter((e) => !opts.since || !e.received_at || e.received_at >= opts.since)
        .filter((e) => !opts.until || !e.received_at || e.received_at < opts.until)
        .toSorted((a, b) => ((a.received_at ?? "") < (b.received_at ?? "") ? 1 : -1));
      const limit = opts.limit ?? 50;
      return {
        emails: pool.slice(0, limit),
        has_more: pool.length > limit,
        ...(failedSources.length ? { failed_sources: failedSources } : {}),
      };
    },
    getLedger: () => ({
      findDirectMail: () => null,
      listAllCadences: () => rows,
      listActiveCadences: ({ dueByIso }: { dueByIso: string }) =>
        rows.filter(
          (r) => r.status === "active" && r.next_due_at != null && r.next_due_at <= dueByIso,
        ),
      listCadencesForProspect: (prospectId: number) =>
        rows.filter((r) => r.prospect_id === prospectId),
      getCadence: (prospectId: number, playName: string) =>
        rows.find((r) => r.prospect_id === prospectId && r.play_name === playName) ?? null,
      getProspectById: (id: number) => ({ id, name: "P", email: STORED_EMAIL, company: "Co" }),
      findProspectByEmail: (email: string) => {
        const canon = email.trim().toLowerCase();
        lookupArgs.push(canon);
        return canon === STORED_EMAIL ? { id: 1 } : null;
      },
      // v21 reply persistence: the poll stores every matched inbound before
      // recording the reply transition. Attribution mirrors the real
      // latestSentPlayForProspect via the test's `latestSentPlay` knob.
      latestSentPlayForProspect: () => latestSentPlay,
      recordInboxReply: (row: { id: string }) => {
        const isNew = !persistedReplies.some((r) => r.id === row.id);
        if (isNew) persistedReplies.push(row as (typeof persistedReplies)[number]);
        return isNew;
      },
      recordSequenceEvent: (input: {
        prospectId: number;
        playName: string;
        status: string;
        bouncedAt?: string;
      }) => {
        seqEvents.push({
          prospectId: input.prospectId,
          playName: input.playName,
          status: input.status,
          ...(input.bouncedAt !== undefined ? { bouncedAt: input.bouncedAt } : {}),
        });
      },
      setCadenceStatus: ({
        prospectId,
        playName,
        status,
      }: {
        prospectId: number;
        playName: string;
        status: string;
      }) => {
        const r = rows.find((x) => x.prospect_id === prospectId && x.play_name === playName);
        if (r) r.status = status;
      },
      // Mirrors the real ledger.recordProspectReply: every live cadence for the
      // prospect stops (control plane); the analytics event is credited to ONE
      // play — `latestSentPlay` stands in for the subject/latest resolution —
      // and recorded once (idempotent per prospect+play).
      recordProspectReply: (
        prospectId: number,
        opts?: { subject?: string | null; repliedAt?: string | null },
      ) => {
        recordProspectReplyRepliedAts.push(opts?.repliedAt);
        const out = new Map<string, { newlyReplied: boolean; eventRecorded: boolean }>();
        for (const r of rows.filter((x) => x.prospect_id === prospectId)) {
          const live = r.status === "active" || r.status === "paused";
          if (live) r.status = "replied";
          out.set(r.play_name, { newlyReplied: live, eventRecorded: false });
        }
        if (latestSentPlay) {
          const already = repliedSteps.some(
            (x) => x.prospectId === prospectId && x.playName === latestSentPlay,
          );
          if (!already) repliedSteps.push({ prospectId, playName: latestSentPlay });
          out.set(latestSentPlay, {
            newlyReplied: out.get(latestSentPlay)?.newlyReplied ?? false,
            eventRecorded: !already,
          });
        }
        return [...out].map(([playName, r]) => ({
          playName,
          newlyReplied: r.newlyReplied,
          eventRecorded: r.eventRecorded,
        }));
      },
      getPollWatermark: (key: string) => pollState[key] ?? null,
      setPollWatermark: (key: string, value: string) => {
        pollState[key] = value;
      },
      listInboxReplyIntents: (ids: string[]) => {
        const out = new Map<string, { intent: string | null; intentReason: string | null }>();
        for (const id of ids) {
          const v = intents.get(id);
          // Same contract as the real reader: the pending claim reads as NULL.
          if (v) out.set(id, v.intent === "__triage_pending__" ? { ...v, intent: null } : v);
        }
        return out;
      },
      setInboxReplyIntent: (id: string, intent: string | null, intentReason: string | null) => {
        intents.set(id, { intent, intentReason });
      },
      // issue #558 round-1 correction: mirrors the real ledger's
      // `UPDATE ... WHERE intent IS NULL` atomic claim — check-and-mark in
      // one step so an overlapping poll racing the same row can't also
      // claim it. Returns true (claim won) only when intent isn't already
      // set (NULL or unset); the mock doesn't need real concurrency since a
      // single test only ever calls this synchronously in sequence, but the
      // semantics (claim fails once intent is non-null) must match.
      claimInboxReplyForTriage: (id: string) => {
        const cur = intents.get(id);
        if (cur && cur.intent != null) return false;
        intents.set(id, { intent: "__triage_pending__", intentReason: cur?.intentReason ?? null });
        return true;
      },
    }),
  };
});

// Round-1 correction (#558): claimInboxReplyForTriage's atomic
// check-and-mark on `intent` gates the paid triageEmails call — mocked here
// so the dedupe test below can assert call counts/args without hitting a
// real LLM.
const triageEmailsMock = vi.fn(async (emails: Array<{ id: string }>) =>
  emails.map((e) => ({
    id: e.id,
    from: "x",
    subject: "x",
    category: "interested" as const,
    reasoning: "r",
  })),
);
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, triageEmails: triageEmailsMock };
});

const { advanceCadence, pollInboxReplies } = await import("../src/_cadence.ts");

const PAST = "2000-01-01T00:00:00.000Z"; // always due

beforeEach(() => {
  calls.sendEmail = 0;
  lookupArgs = [];
  inboxEmails = [];
  repliedSteps = [];
  persistedReplies = [];
  seqEvents = [];
  recordProspectReplyRepliedAts = [];
  notifySlackReplyReceivedMock.mockClear();
  notifySlackBounceRecordedMock.mockClear();
  intents = new Map();
  triageEmailsMock.mockClear();
  angleRefreshCalls = [];
  // The fixture cadence is also the latest play that emailed the prospect.
  latestSentPlay = "stack-consolidation";
  pollState = {};
  listInboxArgs = [];
  failedSources = [];
  rows = [
    {
      prospect_id: 1,
      play_name: "stack-consolidation",
      status: "active",
      next_due_at: PAST, // due now — would send a step if not for the reply
      prospect_email: STORED_EMAIL,
    },
  ];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("advanceCadence — reply detection", () => {
  it("a mixed-case inbound reply marks the cadence replied and skips the due step", async () => {
    inboxEmails = [
      { from: "Sophia Stein <Sophia@AgenticArchitect.AI>", subject: "re: your agent stack" },
    ];

    const result = await advanceCadence({ dryRun: false });

    // Inbound from-address was normalized to lowercase before lookup.
    expect(lookupArgs).toContain(STORED_EMAIL);
    expect(result.repliesDetected).toBe(1);
    expect(rows[0]?.status).toBe("replied");
    // The due step did NOT fire — the reply stopped it.
    expect(result.stepsExecuted).toBe(0);
    expect(calls.sendEmail).toBe(0);
  });

  it("a reply from an unknown address leaves the cadence active (no false positive)", async () => {
    inboxEmails = [{ from: "Someone Else <nobody@elsewhere.com>", subject: "spam" }];
    rows[0]!.next_due_at = "2999-01-01T00:00:00.000Z"; // not due → isolate reply logic

    const result = await advanceCadence({ dryRun: false });

    expect(result.repliesDetected).toBe(0);
    expect(rows[0]?.status).toBe("active");
  });

  it("dry-run does not poll the inbox", async () => {
    inboxEmails = [{ from: "Sophia Stein <Sophia@AgenticArchitect.AI>", subject: "re" }];
    rows[0]!.next_due_at = "2999-01-01T00:00:00.000Z";

    const result = await advanceCadence({ dryRun: true });

    expect(result.polled).toBe(0);
    expect(result.repliesDetected).toBe(0);
    expect(rows[0]?.status).toBe("active");
  });

  it("credits the reply to the inbound email's own received_at, not the poll time", async () => {
    // Regression test for round-2 review finding: recordProspectReply must be
    // called with the inbound email's own timestamp so a backlog reply is
    // attributed to the day it actually arrived (see markLatestStepReplied /
    // eventsByPlay's replied_at note), not the day this poll happened to run.
    inboxEmails = [
      {
        from: "Sophia Stein <Sophia@AgenticArchitect.AI>",
        subject: "re: your agent stack",
        received_at: "2026-08-20T09:00:00.000Z",
      },
    ];

    await advanceCadence({ dryRun: false });

    expect(recordProspectReplyRepliedAts).toEqual(["2026-08-20T09:00:00.000Z"]);
  });
});

describe("pollInboxReplies — standalone background detection (no sends)", () => {
  it("flips a matching active cadence to replied and records the reply event", async () => {
    inboxEmails = [{ from: "Sophia <sophia@agenticarchitect.ai>", subject: "re: stack" }];

    const result = await pollInboxReplies();

    expect(result.polled).toBe(1);
    expect(result.repliesDetected).toBe(1);
    expect(result.details[0]).toMatchObject({
      prospectEmail: STORED_EMAIL,
      playName: "stack-consolidation",
    });
    expect(rows[0]?.status).toBe("replied");
    // The reply metric (home/CAC) is fed via markLatestStepReplied.
    expect(repliedSteps).toEqual([{ prospectId: 1, playName: "stack-consolidation" }]);
    expect(calls.sendEmail).toBe(0);
  });

  // Issue #357: a genuinely new human reply refreshes the per-prospect angle.
  it("triggers an angle refresh for a new human reply", async () => {
    inboxEmails = [{ id: "m1", from: "sophia@agenticarchitect.ai", subject: "re: stack" }];

    await pollInboxReplies();

    expect(angleRefreshCalls).toEqual([1]);
  });

  it("does not trigger an angle refresh for a re-swept already-recorded reply", async () => {
    inboxEmails = [{ id: "m1", from: "sophia@agenticarchitect.ai", subject: "re: stack" }];

    await pollInboxReplies();
    angleRefreshCalls = [];
    // Same email re-examined by the watermark overlap: recordInboxReply's
    // INSERT OR IGNORE reports it as not-new.
    await pollInboxReplies();

    expect(angleRefreshCalls).toEqual([]);
  });

  it("persists every matched inbound (body included) into inbox_replies", async () => {
    inboxEmails = [
      { id: "m1", from: "Sophia <sophia@agenticarchitect.ai>", subject: "re: stack" },
      { id: "m2", from: "Someone Else <nobody@elsewhere.com>", subject: "spam" },
    ];

    await pollInboxReplies();
    // Matched mail is stored; unmatched noise is not.
    expect(persistedReplies.map((r) => r.id)).toEqual(["m1"]);
    expect(persistedReplies[0]).toMatchObject({
      prospectId: 1,
      fromEmail: STORED_EMAIL,
      playName: "stack-consolidation",
    });

    // A later reply on the same (already-replied) thread is stored too — the
    // per-(prospect, play) reply transition being idempotent must not stop
    // the message capture.
    inboxEmails = [
      { id: "m3", from: "Sophia <sophia@agenticarchitect.ai>", subject: "re: re: stack" },
    ];
    await pollInboxReplies();
    expect(persistedReplies.map((r) => r.id)).toEqual(["m1", "m3"]);
  });

  it("fires a Slack reply-received notification on first sight only (background poll path)", async () => {
    inboxEmails = [{ id: "m1", from: "Sophia <sophia@agenticarchitect.ai>", subject: "re: stack" }];

    await pollInboxReplies();

    expect(notifySlackReplyReceivedMock).toHaveBeenCalledTimes(1);
    expect(notifySlackReplyReceivedMock).toHaveBeenCalledWith({
      from_email: STORED_EMAIL,
      subject: "re: stack",
      play_name: "stack-consolidation",
      kind: "human",
    });

    // Re-polling the same window re-sees the same message id but must not
    // notify again — recordInboxReply's INSERT OR IGNORE already dedupes it.
    await pollInboxReplies();
    expect(notifySlackReplyReceivedMock).toHaveBeenCalledTimes(1);
  });

  it("backfills the reply event for an already-replied cadence; no cadence is stopped", async () => {
    // A cadence flipped to replied before the reply-event code existed: the
    // next poll still records the event (it's new to the metrics), but there
    // was no active cadence to stop.
    rows[0]!.status = "replied";
    inboxEmails = [{ from: "sophia@agenticarchitect.ai", subject: "re" }];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(1);
    expect(result.cadencesStopped).toBe(0);
    expect(repliedSteps).toEqual([{ prospectId: 1, playName: "stack-consolidation" }]);
  });

  it("records the reply for a terminal (breakup) cadence without resurrecting it", async () => {
    rows[0]!.status = "breakup";
    inboxEmails = [{ from: "sophia@agenticarchitect.ai", subject: "re" }];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(1);
    expect(result.cadencesStopped).toBe(0);
    expect(rows[0]?.status).toBe("breakup");
    expect(repliedSteps).toEqual([{ prospectId: 1, playName: "stack-consolidation" }]);
  });

  it("records a reply to a one-touch play that never enrolled a cadence", async () => {
    rows = []; // luma-events leaves no cadence_state row
    latestSentPlay = "luma-events";
    inboxEmails = [{ from: "sophia@agenticarchitect.ai", subject: "re: the meetup" }];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(1);
    expect(result.details[0]).toMatchObject({
      prospectEmail: STORED_EMAIL,
      playName: "luma-events",
    });
    expect(repliedSteps).toEqual([{ prospectId: 1, playName: "luma-events" }]);
  });

  it("is idempotent across polls — the same inbound email is not recounted", async () => {
    inboxEmails = [{ from: "sophia@agenticarchitect.ai", subject: "re" }];

    expect((await pollInboxReplies()).repliesDetected).toBe(1);
    expect((await pollInboxReplies()).repliesDetected).toBe(0);
    expect(repliedSteps).toHaveLength(1);
  });

  // Round-1 correction (#480): the overlap window and backlog drain
  // deliberately re-walk mail the ledger already has, so a `human` reply
  // already recorded (and triaged) by a prior poll must not be re-sent to
  // the paid triageEmails call every time it's re-examined.
  it("does not re-triage a human reply already recorded by a prior poll", async () => {
    inboxEmails = [{ id: "m1", from: "sophia@agenticarchitect.ai", subject: "re: stack" }];

    await pollInboxReplies();
    expect(triageEmailsMock).toHaveBeenCalledTimes(1);
    expect(triageEmailsMock.mock.calls[0]![0]).toMatchObject([{ id: "m1" }]);

    // Same watermark-overlap re-examination sees the identical email again —
    // recordInboxReply reports it as not-new (INSERT OR IGNORE no-op), so the
    // triage call must be skipped this time.
    await pollInboxReplies();
    expect(triageEmailsMock).toHaveBeenCalledTimes(1);
  });

  // Round-1 correction (#558): two overlapping pollInboxReplies() calls
  // (realistically: the server's background scheduler tick and a manually-run
  // `cadence advance` CLI invocation) both observe the same freshly-inserted
  // row with intent still NULL while the first call's triageEmails() await is
  // in flight. The atomic claim (claimInboxReplyForTriage) must let only one
  // of them actually call the paid triageEmails — a bare re-check of `intent`
  // would let both through since neither has written back yet.
  it("does not double-triage the same reply across two overlapping polls", async () => {
    inboxEmails = [{ id: "m1", from: "sophia@agenticarchitect.ai", subject: "re: stack" }];
    // Simulate the first poll's triage call being slow (still in flight)
    // when the second, overlapping poll starts.
    let resolveFirst: (() => void) | null = null;
    triageEmailsMock.mockImplementationOnce(
      (emails: Array<{ id: string }>) =>
        new Promise((resolve) => {
          resolveFirst = (): void =>
            resolve(
              emails.map((e) => ({
                id: e.id,
                from: "x",
                subject: "x",
                category: "interested" as const,
                reasoning: "r",
              })),
            );
        }),
    );

    const firstPoll = pollInboxReplies();
    // Give the first poll's synchronous prelude (recordInboxReply, the claim)
    // a turn to run before starting the second, overlapping poll.
    await Promise.resolve();
    await Promise.resolve();
    const secondPoll = pollInboxReplies();

    (resolveFirst as (() => void) | null)?.();
    await Promise.all([firstPoll, secondPoll]);

    expect(triageEmailsMock).toHaveBeenCalledTimes(1);
  });
});

describe("pollInboxReplies — watermark", () => {
  it("polls from the persisted watermark (with overlap) and advances it on a clean poll", async () => {
    pollState["inbox_replies"] = "2026-08-20T12:00:00.000Z";
    inboxEmails = [
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-20T12:30:00.000Z" },
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-20T13:00:00.000Z" },
    ];

    await pollInboxReplies();

    // `since` = watermark minus the one-hour overlap, so a second-granular or
    // out-of-order delivery at the boundary is re-examined, not skipped.
    expect(listInboxArgs.at(-1)).toMatchObject({ since: "2026-08-20T11:00:00.000Z", limit: 200 });
    // Advanced to the newest received_at seen, not to "now".
    expect(watermarkOf()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("does not advance the watermark when a source failed (the gap must be re-covered)", async () => {
    pollState["inbox_replies"] = "2026-08-20T12:00:00.000Z";
    inboxEmails = [
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-20T13:00:00.000Z" },
    ];
    failedSources = ["gmail:jn@example.com"];

    await pollInboxReplies();

    expect(watermarkOf()).toBe("2026-08-20T12:00:00.000Z");
  });

  it("first poll has no since (the 30-day backfill) and then pins the watermark", async () => {
    inboxEmails = [
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-01T00:00:00.000Z" },
    ];

    await pollInboxReplies();

    expect(listInboxArgs.at(-1)).not.toHaveProperty("since");
    expect(watermarkOf()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("pages backwards through a catch-up larger than one window and finds the reply on page 3", async () => {
    const at = (h: number) => `2026-08-20T${String(h).padStart(2, "0")}:00:00.000Z`;
    inboxEmails = [
      { from: "a@elsewhere.com", subject: "noise", received_at: at(15) },
      { from: "b@elsewhere.com", subject: "noise", received_at: at(14) },
      { from: "c@elsewhere.com", subject: "noise", received_at: at(13) },
      { from: "d@elsewhere.com", subject: "noise", received_at: at(12) },
      { from: "sophia@agenticarchitect.ai", subject: "re: stack", received_at: at(11) },
    ];

    const result = await pollInboxReplies({ pageSize: 2 });

    // Page 2 is bounded one second past page 1's oldest (inclusive boundary).
    expect(listInboxArgs[1]).toMatchObject({ until: "2026-08-20T14:00:01.000Z" });
    expect(result.polled).toBe(5);
    expect(result.repliesDetected).toBe(1);
    expect(watermarkOf()).toBe(at(15));
    expect(pollState["inbox_replies_backlog"]).toBeUndefined();
  });

  it("does not skip a reply that shares the boundary second with a page's oldest message", async () => {
    const t = "2026-08-20T12:00:00.000Z";
    inboxEmails = [
      {
        id: "x",
        from: "a@elsewhere.com",
        subject: "noise",
        received_at: "2026-08-20T13:00:00.000Z",
      },
      { id: "y", from: "b@elsewhere.com", subject: "noise", received_at: t },
      { id: "z", from: "sophia@agenticarchitect.ai", subject: "re: stack", received_at: t },
    ];

    const result = await pollInboxReplies({ pageSize: 2 });

    expect(result.repliesDetected).toBe(1);
    expect(result.polled).toBe(3); // boundary mail re-fetched, de-duplicated by id
  });

  it("parks the unreached remainder as backlog and drains it on the next poll", async () => {
    const at = (h: number) => `2026-08-20T${String(h).padStart(2, "0")}:00:00.000Z`;
    inboxEmails = [
      { from: "a@elsewhere.com", subject: "noise", received_at: at(16) },
      { from: "b@elsewhere.com", subject: "noise", received_at: at(15) },
      { from: "c@elsewhere.com", subject: "noise", received_at: at(14) },
      { from: "sophia@agenticarchitect.ai", subject: "re: stack", received_at: at(13) },
    ];

    // Budget of one page of two: sees 16:00 and 15:00, parks (floor, 15:00].
    const first = await pollInboxReplies({ pageSize: 2, maxPages: 1 });
    expect(first.repliesDetected).toBe(0);
    expect(watermarkOf()).toBe(at(16)); // the live window is done; it advances
    expect(JSON.parse(pollState["inbox_replies_backlog"]!)).toMatchObject({ until: at(15) });

    // Next poll: the live window is empty past the watermark; the spare page
    // budget drains the backlog and finds the reply.
    const second = await pollInboxReplies({ pageSize: 2, maxPages: 2 });
    expect(second.repliesDetected).toBe(1);
    expect(pollState["inbox_replies_backlog"]).toBe("");
  });
});

describe("pollInboxReplies — auto-reply classification (v23)", () => {
  it("an OOO autoresponder is stored but is NOT a reply: cadence stays active", async () => {
    inboxEmails = [
      {
        from: "Sophia Stein <sophia@agenticarchitect.ai>",
        subject: "Automatic reply: your agent stack",
      },
    ];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(0);
    expect(result.autoRepliesSkipped).toBe(1);
    expect(result.cadencesStopped).toBe(0);
    expect(rows[0]?.status).toBe("active"); // follow-ups continue
    expect(repliedSteps).toHaveLength(0); // no sequence_events flip → metric untouched
    expect(persistedReplies).toHaveLength(1); // conversation history stays complete
    expect(persistedReplies[0]?.kind).toBe("auto");
    // Issue #357: an auto-reply is never signal worth paying to re-synthesize.
    expect(angleRefreshCalls).toEqual([]);
    // Autoresponders are not replies by classifyReply's own contract — must
    // not raise a false "Reply from ..." Slack alert (round-1 correction).
    expect(notifySlackReplyReceivedMock).not.toHaveBeenCalled();
  });

  it("a dead-mailbox autoresponder stops the cadence as bounced, not replied", async () => {
    inboxEmails = [
      {
        from: "sophia@agenticarchitect.ai",
        subject: "out of office Re: your agent stack",
        // The real 2026-08-27 payload shape: retired, address dead.
        body: "Retired October 2025. No longer using this email.",
        received_at: "2026-08-27T16:07:46.000Z",
      },
    ];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(0);
    expect(result.autoRepliesSkipped).toBe(1);
    expect(result.cadencesStopped).toBe(1);
    expect(rows[0]?.status).toBe("bounced");
    expect(repliedSteps).toHaveLength(0);
    expect(seqEvents).toEqual([
      {
        prospectId: 1,
        playName: "stack-consolidation",
        status: "bounced",
        // Occurrence time (the autoresponder's own received_at), not poll
        // time — matches the DSN-bounce path's bouncedAt so both feed the
        // Slack daily summary's occurrence window consistently.
        bouncedAt: "2026-08-27T16:07:46.000Z",
      },
    ]);
    expect(persistedReplies[0]?.kind).toBe("auto_permanent");
    expect(notifySlackReplyReceivedMock).not.toHaveBeenCalled();
    // issue #71 round-4 review finding: the auto_permanent bounce path is
    // counted into the Slack daily summary's bounced total (via
    // Ledger.countAutoPermanentBounces) but never fired the Slack
    // "bounce recorded" event itself. Must fire exactly once per
    // autoresponder email, not once per cadence stopped.
    expect(notifySlackBounceRecordedMock).toHaveBeenCalledTimes(1);
    expect(notifySlackBounceRecordedMock).toHaveBeenCalledWith({
      recipient: STORED_EMAIL,
      kind: "auto_permanent",
      status_code: null,
    });
  });

  // issue #71 round-5 review finding: the alert above was gated only on
  // `kind === "auto_permanent"`, not on first-sight. The reply poll's `since`
  // window intentionally re-examines up to REPLY_WATERMARK_OVERLAP_MS (1h)
  // before the watermark on every poll, and `seen` only dedupes within a
  // single pollInboxReplies() call — so the SAME dead-mailbox autoresponder,
  // still inside that overlap window on the next poll, would refire the
  // alert a second time. It must be gated on isNewReply (recordInboxReply's
  // INSERT OR IGNORE return), exactly like the human-reply branch is.
  it("does not refire the bounce alert when the same autoresponder email is re-seen on a later poll", async () => {
    inboxEmails = [
      {
        id: "dead-mailbox-1",
        from: "sophia@agenticarchitect.ai",
        subject: "out of office Re: your agent stack",
        body: "Retired October 2025. No longer using this email.",
        received_at: "2026-08-27T16:07:46.000Z",
      },
    ];

    const first = await pollInboxReplies();
    expect(first.autoRepliesSkipped).toBe(1);
    expect(notifySlackBounceRecordedMock).toHaveBeenCalledTimes(1);

    // Second poll re-fetches the same email id — exactly what happens when
    // the next poll's `since` (watermark - 1h overlap) still covers this
    // email's received_at. recordInboxReply's INSERT OR IGNORE means
    // isNewReply is false this time; the alert must not refire.
    const second = await pollInboxReplies();
    expect(second.autoRepliesSkipped).toBe(1);
    expect(notifySlackBounceRecordedMock).toHaveBeenCalledTimes(1);
  });

  it("an unsubscribe request stops the cadence as unsubscribed", async () => {
    inboxEmails = [
      {
        from: "sophia@agenticarchitect.ai",
        subject: "Re: your agent stack",
        body: "Please remove me from your list.",
      },
    ];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(0);
    expect(result.autoRepliesSkipped).toBe(1);
    expect(result.cadencesStopped).toBe(1);
    expect(rows[0]?.status).toBe("unsubscribed");
    expect(seqEvents).toEqual([
      { prospectId: 1, playName: "stack-consolidation", status: "unsubscribed" },
    ]);
    expect(persistedReplies[0]?.kind).toBe("unsubscribe");
    // Issue #357: an unsubscribe is never signal worth paying to re-synthesize.
    expect(angleRefreshCalls).toEqual([]);
    expect(notifySlackReplyReceivedMock).not.toHaveBeenCalled();
    // Unsubscribe is a do-not-contact, not a bounce — must not raise a
    // "Bounce recorded" alert (only auto_permanent is a bounce by this
    // codebase's own status mapping above).
    expect(notifySlackBounceRecordedMock).not.toHaveBeenCalled();
  });

  it("a terminal cadence is not resurrected or re-stopped by a dead-mailbox notice", async () => {
    rows[0]!.status = "completed";
    inboxEmails = [
      {
        from: "sophia@agenticarchitect.ai",
        subject: "Automatic reply: gone",
        body: "I have retired and am no longer using this email.",
      },
    ];

    const result = await pollInboxReplies();

    expect(result.cadencesStopped).toBe(0);
    expect(rows[0]?.status).toBe("completed");
    expect(seqEvents).toHaveLength(0);
  });

  it("a Gmail header verdict (auto_submitted) suppresses the reply even with a human-looking body", async () => {
    inboxEmails = [
      {
        from: "sophia@agenticarchitect.ai",
        subject: "Re: your agent stack",
        body: "Thanks for your email, I will get back to you.",
        auto_submitted: true,
      },
    ];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(0);
    expect(result.autoRepliesSkipped).toBe(1);
    expect(rows[0]?.status).toBe("active");
  });
});
