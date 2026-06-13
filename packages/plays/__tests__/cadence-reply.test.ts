import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the reply-detection block of advanceCadence (inbox poll → match
// from-address to a prospect → mark the cadence `replied` → next step is
// skipped). The previously-untested path that decides whether the tool keeps
// emailing someone who already replied.

const calls = { sendEmail: 0 };
let inboxEmails: Array<{ from: string; subject: string }> = [];
let lookupArgs: string[] = [];
// (prospectId, playName) pairs passed to markLatestStepReplied this run.
let repliedSteps: Array<{ prospectId: number; playName: string }> = [];

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
    listInbox: async () => ({ emails: inboxEmails, has_more: false }),
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
      // Mirrors the real ledger.recordCadenceReply: flip active→replied + record
      // the analytics event; already-replied only backfills; terminal untouched.
      recordCadenceReply: ({ prospectId, playName }: { prospectId: number; playName: string }) => {
        const r = rows.find((x) => x.prospect_id === prospectId && x.play_name === playName);
        const newlyReplied = r?.status === "active";
        if (newlyReplied && r) r.status = "replied";
        if (newlyReplied || r?.status === "replied") repliedSteps.push({ prospectId, playName });
        return { newlyReplied };
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

  it("backfills the reply event for an already-replied cadence without recounting", async () => {
    // Simulates a cadence flipped to replied before the reply-event code existed:
    // the next poll must still record the event, but not re-increment the count.
    rows[0]!.status = "replied";
    inboxEmails = [{ from: "sophia@agenticarchitect.ai", subject: "re" }];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(0);
    expect(repliedSteps).toEqual([{ prospectId: 1, playName: "stack-consolidation" }]);
  });

  it("leaves a non-replied/active cadence (breakup) untouched", async () => {
    rows[0]!.status = "breakup";
    inboxEmails = [{ from: "sophia@agenticarchitect.ai", subject: "re" }];

    const result = await pollInboxReplies();

    expect(result.repliesDetected).toBe(0);
    expect(repliedSteps).toEqual([]);
  });
});
