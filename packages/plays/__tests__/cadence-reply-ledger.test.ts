import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";

// Round-1 correction (#663, finding F-t_1a68f4ce-2): cadence-reply.test.ts's
// regression for the intent=unsubscribe triage path drives `pollInboxReplies`
// against a fully mocked `getLedger()` stub — `setCadenceStatus`,
// `recordSequenceEvent` and `recordProspectReply` are hand-rolled fakes that
// don't share ANY code with the real `Ledger` class, so a test passing there
// proves nothing about the real SQLite composition of those three calls (the
// exact thing under question: does the real `recordProspectReply` also write
// an ordinary-reply `sequence_events` row / flip `cadence_state` for a
// cadence this poll just marked `unsubscribed`?). This file drives the same
// scenario against a real `Ledger` backed by `bun:sqlite` (`:memory:`) — only
// `listInbox`, `loadConfig` and `triageEmails` are mocked (the network/LLM
// edges), exactly the pattern `mail-cadence.test.ts` and `calendar-poll.test.ts`
// already use for their own real-Ledger coverage.

let inboxEmails: Array<{
  id?: string;
  from: string;
  subject: string;
  body?: string;
  received_at?: string;
}> = [];
let ledger: Ledger;
const triageEmailsMock = vi.fn(async (emails: Array<{ id: string }>) =>
  emails.map((e) => ({
    id: e.id,
    from: "x",
    subject: "x",
    category: "unsubscribe" as const,
    reasoning: "asked to be removed",
  })),
);

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ founderName: "J", productOneLiner: "thing" }),
    getLedger: () => ledger,
    listInbox: async (opts: { since?: string; until?: string; limit?: number }) => {
      const pool = inboxEmails.map((e, i) => {
        const id = e.id ?? `m${i}`;
        return { id, from: e.from, subject: e.subject, body: e.body, received_at: e.received_at };
      });
      const limit = opts.limit ?? 50;
      return { emails: pool.slice(0, limit), has_more: pool.length > limit };
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, triageEmails: triageEmailsMock };
});

const { pollInboxReplies } = await import("../src/_cadence.ts");

const STORED_EMAIL = "sophia@agenticarchitect.ai";

beforeEach(() => {
  ledger = new Ledger(":memory:");
  inboxEmails = [];
  triageEmailsMock.mockClear();
});

afterEach(() => {
  ledger.close();
  vi.clearAllMocks();
});

describe("pollInboxReplies — intent=unsubscribe triage against the real Ledger (#663)", () => {
  it("persists unsubscribed cadence state and a matching sequence event, WITHOUT also recording an ordinary reply", async () => {
    const prospectId = ledger.upsertProspect({
      name: "Sophia",
      email: STORED_EMAIL,
      source: "stack-consolidation",
    });
    ledger.enrollCadence({
      prospectId,
      playName: "stack-consolidation",
      nextDueAt: "2026-01-01T00:00:00Z",
    });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "stack-consolidation",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "your agent stack" },
    });
    expect(ledger.getCadence(prospectId, "stack-consolidation")?.status).toBe("active");

    // classifyReply's own phrase-based UNSUBSCRIBE_RE does NOT match this
    // body (no "remove me" / "unsubscribe" / etc.) — it lands as kind=human,
    // exactly the gap #663 exists to close. Only the sentiment triage mock
    // above (standing in for issue #480's LLM classifier) reads intent as
    // 'unsubscribe'.
    inboxEmails = [
      {
        id: "m1",
        from: `Sophia <${STORED_EMAIL}>`,
        subject: "Re: your agent stack",
        body: "This isn't relevant to our team, please don't send any more of these.",
        received_at: "2026-08-20T09:00:00.000Z",
      },
    ];

    const result = await pollInboxReplies();

    // Control plane: the real Ledger.setCadenceStatus flipped the cadence.
    const cadence = ledger.getCadence(prospectId, "stack-consolidation");
    expect(cadence?.status).toBe("unsubscribed");
    expect(result.cadencesStopped).toBe(1);

    // Analytics plane: exactly one sequence_events row was added by this
    // poll (the original 'sent' row plus this one) — 'unsubscribed', not
    // 'replied'. This is the real INSERT recordSequenceEvent/setCadenceStatus
    // produce through bun:sqlite, not a mock's in-memory array.
    const allEvents = ledger.listAllSequenceEventsForProspect(prospectId);
    expect(allEvents.map((e) => e.status)).toEqual(["sent", "unsubscribed"]);
    // F-2's core assertion: no 'replied' row exists anywhere for this
    // (prospect, play) — proving recordProspectReply's markLatestStepReplied
    // (which flips the 'sent' row to 'replied') never ran for this poll.
    expect(allEvents.some((e) => e.status === "replied")).toBe(false);

    // F-1's real-Ledger corollary: repliesDetected must stay 0 — the
    // ordinary-reply counting path (recordProspectReply) must not have run
    // at all for this triaged-unsubscribe email.
    expect(result.repliesDetected).toBe(0);
  });

  it("does not resurrect a terminal (breakup) cadence, and still skips the ordinary-reply path", async () => {
    const prospectId = ledger.upsertProspect({
      name: "Sophia",
      email: STORED_EMAIL,
      source: "stack-consolidation",
    });
    ledger.enrollCadence({
      prospectId,
      playName: "stack-consolidation",
      nextDueAt: "2026-01-01T00:00:00Z",
    });
    ledger.setCadenceStatus({ prospectId, playName: "stack-consolidation", status: "breakup" });

    inboxEmails = [
      {
        id: "m1",
        from: `Sophia <${STORED_EMAIL}>`,
        subject: "Re: your agent stack",
        body: "Please stop reaching out.",
        received_at: "2026-08-20T09:00:00.000Z",
      },
    ];

    const result = await pollInboxReplies();

    // listCadencesForProspect's active/paused filter (in both the unsubscribe
    // branch and recordProspectReply) correctly leaves an already-terminal
    // cadence alone — no cadence to stop, and (per F-1) no fallback into the
    // ordinary-reply path either, so it isn't miscounted as a reply.
    expect(result.cadencesStopped).toBe(0);
    expect(result.repliesDetected).toBe(0);
    expect(ledger.getCadence(prospectId, "stack-consolidation")?.status).toBe("breakup");
  });
});
