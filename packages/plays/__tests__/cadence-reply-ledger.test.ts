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
    // A breakup-revive row already queued for this prospect must not go out
    // after they asked to be removed: setCadenceStatus touches cadence_state
    // only, so the unsubscribe branch expires the row itself.
    const reviveRowId = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: { email: STORED_EMAIL, name: "Sophia" },
      dedupeKey: `prospect:${prospectId}`,
      source: "breakup-revive",
    });

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

    // The queued breakup-revive row is expired, with the reason on its notes.
    expect(reviveRowId).not.toBeNull();
    const revive = ledger.listQueue({ ids: [reviveRowId as number], limit: 1 })[0];
    expect(revive?.status).toBe("expired");
    expect(revive?.notes).toMatch(/prospect unsubscribed/);
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

  // Round-2 correction (#663, F-2): a REPEATED pass — the watermark-overlap
  // window re-examines a reply a prior poll already fully triaged as
  // 'unsubscribe'. This poll's `claimInboxReplyForTriage` loses (intent is
  // already non-NULL), so it must read the persisted result back via
  // `peekInboxReplyIntent` and still take the unsubscribe veto, not fall
  // through to `recordProspectReply`/`tagOutcomeValue` for a second time.
  it("vetoes recordProspectReply on a repeated pass over an already-triaged unsubscribe reply", async () => {
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

    inboxEmails = [
      {
        id: "m1",
        from: `Sophia <${STORED_EMAIL}>`,
        subject: "Re: your agent stack",
        body: "This isn't relevant to our team, please don't send any more of these.",
        received_at: "2026-08-20T09:00:00.000Z",
      },
    ];

    // First poll: wins the claim, triages as unsubscribe, stops the cadence.
    const first = await pollInboxReplies();
    expect(first.repliesDetected).toBe(0);
    expect(ledger.getCadence(prospectId, "stack-consolidation")?.status).toBe("unsubscribed");
    expect(triageEmailsMock).toHaveBeenCalledTimes(1);

    // Second poll: the same email id is re-examined (overlap window /
    // backlog re-walk). recordInboxReply's INSERT OR IGNORE makes this a
    // no-op insert, and claimInboxReplyForTriage now loses (intent is
    // already 'unsubscribe', not NULL) — before the round-2 fix this fell
    // straight through to recordProspectReply/tagOutcomeValue.
    const second = await pollInboxReplies();

    // No second (paid) triage call — the claim loss is expected.
    expect(triageEmailsMock).toHaveBeenCalledTimes(1);
    // The billing-relevant assertion: still zero replies detected/counted,
    // and no 'replied' sequence_events row was ever written for this
    // (prospect, play) across either pass.
    expect(second.repliesDetected).toBe(0);
    expect(second.cadencesStopped).toBe(0); // already unsubscribed — no live cadence left to stop
    const allEvents = ledger.listAllSequenceEventsForProspect(prospectId);
    expect(allEvents.map((e) => e.status)).toEqual(["sent", "unsubscribed"]);
    expect(allEvents.some((e) => e.status === "replied")).toBe(false);
  });

  // Round-2 correction (#663, F-2): a CONCURRENT claim loss — a second,
  // overlapping pollInboxReplies() call observes the same row while the
  // first call's triageEmails() await is still in flight (intent is the
  // '__triage_pending__' sentinel, not yet a real category). The loser must
  // not guess and must skip BOTH the unsubscribe veto and the ordinary
  // reply bookkeeping for this pass — `peekInboxReplyIntent` reports
  // `pending: true` for exactly this window.
  it("skips reply bookkeeping entirely for a concurrent claim-loss while triage is still in flight", async () => {
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

    inboxEmails = [
      {
        id: "m1",
        from: `Sophia <${STORED_EMAIL}>`,
        subject: "Re: your agent stack",
        body: "This isn't relevant to our team, please don't send any more of these.",
        received_at: "2026-08-20T09:00:00.000Z",
      },
    ];

    // Hold the first poll's triage call open until the second, overlapping
    // poll has had a chance to run its own claim attempt against it.
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
                category: "unsubscribe" as const,
                reasoning: "asked to be removed",
              })),
            );
        }),
    );

    const firstPoll = pollInboxReplies();
    // Let the first poll's synchronous prelude (recordInboxReply, the
    // winning claim) run before starting the overlapping second poll.
    await Promise.resolve();
    await Promise.resolve();
    const secondPoll = pollInboxReplies();

    (resolveFirst as (() => void) | null)?.();
    const [, secondResult] = await Promise.all([firstPoll, secondPoll]);

    // Only one paid triage call — the second poll lost the claim.
    expect(triageEmailsMock).toHaveBeenCalledTimes(1);
    // The loser's own poll result must not have counted this row as an
    // ordinary reply while the real category was still unresolved.
    expect(secondResult.repliesDetected).toBe(0);

    // Once the winner's triage resolves, the row lands as unsubscribed and
    // no 'replied' row is ever written by either pass.
    expect(ledger.getCadence(prospectId, "stack-consolidation")?.status).toBe("unsubscribed");
    const allEvents = ledger.listAllSequenceEventsForProspect(prospectId);
    expect(allEvents.map((e) => e.status)).toEqual(["sent", "unsubscribed"]);
    expect(allEvents.some((e) => e.status === "replied")).toBe(false);
  });
});
