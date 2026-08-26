import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the reply-detection block of advanceCadence (inbox poll → match
// from-address to a prospect → mark the cadence `replied` → next step is
// skipped). The previously-untested path that decides whether the tool keeps
// emailing someone who already replied.

const calls = { sendEmail: 0 };
let inboxEmails: Array<{ id?: string; from: string; subject: string; received_at?: string }> = [];
let lookupArgs: string[] = [];
let listInboxArgs: Array<Record<string, unknown>> = [];
let failedSources: string[] = [];
// (prospectId, playName) pairs whose sequence_events row flipped to `replied` this run.
let repliedSteps: Array<{ prospectId: number; playName: string }> = [];
// The play behind the prospect's latest sent step — the no-cadence-row fallback.
let latestSentPlay: string | null = null;
// v21 inbox_replies rows captured by the poll (id-keyed, INSERT OR IGNORE semantics).
let persistedReplies: Array<{ id: string }> = [];
// Persisted poll_state rows (watermark + backlog), as the real ledger holds them.
let pollState: Record<string, string> = {};
const watermarkOf = () => pollState["inbox_replies"] ?? null;

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

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ founderName: "J", productOneLiner: "thing" }),
    sendEmail: async () => {
      calls.sendEmail++;
      return { receiptId: 1 };
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
      recordProspectReply: (prospectId: number) => {
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
    }),
  };
});

const { advanceCadence, pollInboxReplies } = await import("../src/_cadence.ts");

const PAST = "2000-01-01T00:00:00.000Z"; // always due

beforeEach(() => {
  calls.sendEmail = 0;
  lookupArgs = [];
  inboxEmails = [];
  repliedSteps = [];
  persistedReplies = [];
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
