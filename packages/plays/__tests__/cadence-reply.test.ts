import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the reply-detection block of advanceCadence (inbox poll → match
// from-address to a prospect → mark the cadence `replied` → next step is
// skipped). The previously-untested path that decides whether the tool keeps
// emailing someone who already replied.

const calls = { sendEmail: 0 };
let inboxEmails: Array<{ from: string; subject: string }> = [];
let lookupArgs: string[] = [];
let listInboxArgs: Array<Record<string, unknown>> = [];
let failedSources: string[] = [];
let inboxPages: Array<Array<{ from: string; subject: string; received_at?: string }>> | null = null;
// (prospectId, playName) pairs whose sequence_events row flipped to `replied` this run.
let repliedSteps: Array<{ prospectId: number; playName: string }> = [];
// The play behind the prospect's latest sent step — the no-cadence-row fallback.
let latestSentPlay: string | null = null;
// Persisted reply-poll watermark, as the real ledger's poll_state row would hold it.
let watermark: string | null = null;

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
    listInbox: async (opts: Record<string, unknown>) => {
      listInboxArgs.push(opts);
      // Paged stub: `inboxPages` (when set) is served one page per call,
      // has_more true until the last; otherwise a single page of `inboxEmails`.
      const page = inboxPages ? (inboxPages[listInboxArgs.length - 1] ?? []) : inboxEmails;
      const hasMore = inboxPages ? listInboxArgs.length < inboxPages.length : false;
      return {
        emails: page,
        has_more: hasMore,
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
      getPollWatermark: () => watermark,
      setPollWatermark: (_key: string, value: string) => {
        watermark = value;
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
  // The fixture cadence is also the latest play that emailed the prospect.
  latestSentPlay = "stack-consolidation";
  watermark = null;
  listInboxArgs = [];
  failedSources = [];
  inboxPages = null;
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
    expect(result.details[0]).toMatchObject({ prospectEmail: STORED_EMAIL, playName: "luma-events" });
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
    watermark = "2026-08-20T12:00:00.000Z";
    inboxEmails = [
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-20T12:30:00.000Z" },
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-20T13:00:00.000Z" },
    ] as never;

    await pollInboxReplies();

    // `since` = watermark minus the one-hour overlap, so a second-granular or
    // out-of-order delivery at the boundary is re-examined, not skipped.
    expect(listInboxArgs.at(-1)).toMatchObject({ since: "2026-08-20T11:00:00.000Z", limit: 200 });
    // Advanced to the newest received_at seen, not to "now".
    expect(watermark).toBe("2026-08-20T13:00:00.000Z");
  });

  it("does not advance the watermark when a source failed (the gap must be re-covered)", async () => {
    watermark = "2026-08-20T12:00:00.000Z";
    inboxEmails = [
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-20T13:00:00.000Z" },
    ] as never;
    failedSources = ["gmail:jn@example.com"];

    await pollInboxReplies();

    expect(watermark).toBe("2026-08-20T12:00:00.000Z");
  });

  it("first poll has no since (the 30-day backfill) and then pins the watermark", async () => {
    inboxEmails = [
      { from: "nobody@elsewhere.com", subject: "noise", received_at: "2026-08-01T00:00:00.000Z" },
    ] as never;

    await pollInboxReplies();

    expect(listInboxArgs.at(-1)).not.toHaveProperty("since");
    expect(watermark).toBe("2026-08-01T00:00:00.000Z");
  });

  it("pages backwards through a catch-up larger than one window, and finds the reply on page 2", async () => {
    inboxPages = [
      [
        { from: "a@elsewhere.com", subject: "noise", received_at: "2026-08-20T13:00:00.000Z" },
        { from: "b@elsewhere.com", subject: "noise", received_at: "2026-08-20T12:00:00.000Z" },
      ],
      [
        { from: "c@elsewhere.com", subject: "noise", received_at: "2026-08-20T11:00:00.000Z" },
        { from: "sophia@agenticarchitect.ai", subject: "re: stack", received_at: "2026-08-20T10:00:00.000Z" },
      ],
    ];

    const result = await pollInboxReplies();

    expect(listInboxArgs).toHaveLength(2);
    // Page 2 is bounded above by page 1's oldest message.
    expect(listInboxArgs[1]).toMatchObject({ until: "2026-08-20T12:00:00.000Z" });
    expect(result.polled).toBe(4);
    expect(result.repliesDetected).toBe(1);
    expect(watermark).toBe("2026-08-20T13:00:00.000Z");
  });
});
