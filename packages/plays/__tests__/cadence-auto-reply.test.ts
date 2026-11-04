import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";

// What an automatic reply does to a sequence, against a real Ledger: a
// "left the company" notice stops it and queues the successor it names for
// review; an out-of-office holds the next step until the person is back
// (never earlier); the backfill reads stored rows again. Only the inbox
// listing, the config and the reply-intent label are mocked.

let inboxEmails: Array<{
  id: string;
  from: string;
  subject: string;
  body?: string;
  received_at: string;
  auto_submitted?: boolean;
}> = [];
let ledger: Ledger;
let config: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => config,
    getLedger: () => ledger,
    listInbox: async (opts: { limit?: number }) => {
      const limit = opts.limit ?? 50;
      return { emails: inboxEmails.slice(0, limit), has_more: inboxEmails.length > limit };
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    classifyReplyIntent: async () => ({
      intent: "interested",
      reason: "",
      confidence: null,
      probabilities: null,
      classifier: "llm:test",
      costMicros: null,
      review: false,
      fellBack: false,
    }),
  };
});

const { pollInboxReplies, runCadenceStepForProspect, reclassifyAutoReplies } =
  await import("../src/index.ts");

const PLAY = "post-funding";
const EMAIL = "dana@halyard.example";
const RECEIVED = "2026-11-04T09:00:00.000Z";
const NOW = new Date("2026-11-04T12:00:00.000Z");

function seed(opts: { nextDueAt?: string } = {}): number {
  const prospectId = ledger.upsertProspect({
    name: "Dana Reyes",
    email: EMAIL,
    company: "Halyard",
    source: PLAY,
  });
  const queueId = ledger.enqueueTarget({
    playName: PLAY,
    payload: {
      email: EMAIL,
      name: "Dana Reyes",
      title: "VP Ops",
      company: "Halyard",
      signal: "raised a seed round",
      offer: { offer: "a thing for Dana" },
    },
    dedupeKey: `email:${EMAIL}`,
    source: "find:test",
  });
  ledger.enrollCadence({
    prospectId,
    playName: PLAY,
    nextDueAt: opts.nextDueAt ?? "2026-11-06T09:00:00.000Z",
    queueId,
  });
  return prospectId;
}

function auto(id: string, subject: string, body: string) {
  return { id, from: EMAIL, subject, body, received_at: RECEIVED, auto_submitted: true };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ledger = new Ledger(":memory:");
  inboxEmails = [];
  config = {};
});

afterEach(() => {
  ledger.close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("a 'left the company' auto-reply", () => {
  it("stops the sequence as left-company and queues the named successor as pending", async () => {
    const prospectId = seed();
    inboxEmails = [
      auto(
        "m1",
        "Automatic reply: quick question",
        "I no longer work for Halyard. With any and all Halyard matters please contact Aino Lehto (aino.lehto@halyard.example).",
      ),
    ];

    const out = await pollInboxReplies();

    expect(out.cadencesStopped).toBe(1);
    const cad = ledger.getCadence(prospectId, PLAY)!;
    expect(cad.status).toBe("bounced");
    expect(cad.hold_reason).toBe("left-company");
    const bounced = ledger
      .listAllSequenceEventsForProspect(prospectId)
      .find((e) => e.status === "bounced")!;
    expect(JSON.parse(bounced.metadata_json!)).toMatchObject({ reason: "left-company" });
    // The address is now suppressed for every sequence.
    expect(ledger.contactSuppressionFor(EMAIL)).not.toBeNull();

    const row = ledger.getQueueRowByDedupe(PLAY, "email:aino.lehto@halyard.example")!;
    expect(row.status).toBe("pending");
    expect(row.source).toBe("auto-reply:successor");
    expect(row.notes).toContain("Dana Reyes");
    const payload = JSON.parse(row.payload_json);
    expect(payload).toMatchObject({
      email: "aino.lehto@halyard.example",
      name: "Aino Lehto",
      company: "Halyard",
      signal: "raised a seed round",
      referredBy: { prospectId, email: EMAIL },
    });
    // The referrer's own person fields never carry over.
    expect(payload.title).toBeUndefined();
    expect(payload.offer).toBeUndefined();

    const stored = ledger.getInboxReplyAutoClassification("m1")!;
    expect(stored.reason).toBe("left_company");
    expect(stored.successor).toMatchObject({
      email: "aino.lehto@halyard.example",
      queueId: row.id,
    });

    // The next poll re-reads the same mail: nothing is queued twice.
    await pollInboxReplies();
    expect(ledger.isQueueDuplicate(PLAY, "email:aino.lehto@halyard.example")).toBe(true);

    // The backfill reading it again keeps the link to the row it queued.
    const again = await reclassifyAutoReplies({
      sinceIso: "2026-10-21T00:00:00.000Z",
      write: true,
    });
    expect(again[0]).toMatchObject({ successorSkip: null });
    expect(again[0]!.action).toContain(`successor queued #${row.id}`);
    expect(ledger.getInboxReplyAutoClassification("m1")?.successor?.queueId).toBe(row.id);
  });

  it("does not queue a successor at another company's domain", async () => {
    seed();
    inboxEmails = [
      auto(
        "m1",
        "Automatic reply",
        "I am no longer with Halyard as of 12 December 2025. Reach me at dana@personal.example.",
      ),
    ];
    await pollInboxReplies();
    expect(ledger.isEmailPendingInQueue("dana@personal.example")).toBe(false);
    expect(ledger.getInboxReplyAutoClassification("m1")?.reason).toBe("left_company");
  });

  it("does not queue anyone when autoReply.queueSuccessor is off", async () => {
    config = { autoReply: { queueSuccessor: false } };
    const prospectId = seed();
    inboxEmails = [
      auto(
        "m1",
        "Automatic reply",
        "This person no longer works at Halyard. Please contact sam.okafor@halyard.example.",
      ),
    ];
    await pollInboxReplies();
    expect(ledger.getCadence(prospectId, PLAY)?.status).toBe("bounced");
    expect(ledger.isEmailPendingInQueue("sam.okafor@halyard.example")).toBe(false);
  });
});

describe("an out-of-office auto-reply", () => {
  it("holds the next step until the return date plus 2 days", async () => {
    const prospectId = seed();
    inboxEmails = [
      auto(
        "m1",
        "Out of office",
        "I am out of office until 14th December. During that time, please contact Mr. Pekka Virtanen.",
      ),
    ];
    await pollInboxReplies();
    const cad = ledger.getCadence(prospectId, PLAY)!;
    expect(cad.status).toBe("active");
    expect(cad.next_due_at).toBe("2026-12-16T00:00:00.000Z");
    expect(cad.held_until).toBe("2026-12-16T00:00:00.000Z");
    expect(cad.hold_reason).toBe("out-of-office");
    expect(cad.return_date).toBe("2026-12-14");
    // An out-of-office never queues anyone.
    expect(ledger.getInboxReplyAutoClassification("m1")).toMatchObject({
      reason: "out_of_office",
      returnDate: "2026-12-14",
      successor: null,
    });
  });

  it("uses the 'back on' date over the 'through' date, and the configured buffer", async () => {
    config = { autoReply: { oooBufferDays: 1 } };
    const prospectId = seed();
    inboxEmails = [
      auto(
        "m1",
        "Automatic reply",
        "I'm out of the country through November 7 with limited access to email. I'll be back on Monday, November 9.",
      ),
    ];
    await pollInboxReplies();
    expect(ledger.getCadence(prospectId, PLAY)?.held_until).toBe("2026-11-10T00:00:00.000Z");
  });

  it("holds an undated notice for 7 days from now", async () => {
    const prospectId = seed();
    inboxEmails = [
      auto("m1", "Automatic reply", "I am on medical leave and will be offline until I am back."),
    ];
    await pollInboxReplies();
    const cad = ledger.getCadence(prospectId, PLAY)!;
    expect(cad.held_until).toBe("2026-11-11T12:00:00.000Z");
    expect(cad.return_date).toBeNull();
  });

  it("never moves the next step earlier", async () => {
    const prospectId = seed({ nextDueAt: "2027-01-10T09:00:00.000Z" });
    inboxEmails = [
      auto("m1", "Out of office", "I am out of the office on vacation until 4 December 2026."),
    ];
    await pollInboxReplies();
    const cad = ledger.getCadence(prospectId, PLAY)!;
    expect(cad.next_due_at).toBe("2027-01-10T09:00:00.000Z");
    expect(cad.held_until).toBe("2026-12-06T00:00:00.000Z");

    // A second, shorter notice does not shorten the hold either.
    inboxEmails = [auto("m2", "Out of office", "Out of office until 20 November.")];
    await pollInboxReplies();
    expect(ledger.getCadence(prospectId, PLAY)?.held_until).toBe("2026-12-06T00:00:00.000Z");
  });

  it("skips a held step unless the founder confirmed the send", async () => {
    const prospectId = seed();
    inboxEmails = [auto("m1", "Out of office", "Out of office until 14th December.")];
    await pollInboxReplies();

    const held = await runCadenceStepForProspect({ prospectId, playName: PLAY, dryRun: true });
    expect(held.action).toBe("skipped");
    expect(held.note).toMatch(/^away until 2026-12-14 \(out-of-office\)/);

    const confirmed = await runCadenceStepForProspect({
      prospectId,
      playName: PLAY,
      dryRun: true,
      confirmHold: true,
    });
    expect(confirmed.note ?? "").not.toMatch(/^away/);
  });
});

describe("mail that is not a person's auto-reply", () => {
  it("reads nothing from a bounce notice", async () => {
    const prospectId = seed();
    inboxEmails = [
      auto(
        "m1",
        "Undeliverable: quick question",
        "Your message could not be delivered. Out of office.",
      ),
    ];
    await pollInboxReplies();
    expect(ledger.getInboxReplyAutoClassification("m1")).toBeNull();
    expect(ledger.getCadence(prospectId, PLAY)?.held_until ?? null).toBeNull();
  });
});

describe("reclassifyAutoReplies (the backfill)", () => {
  function storeAuto(id: string, prospectId: number, body: string) {
    ledger.recordInboxReply({
      id,
      threadKey: id,
      prospectId,
      playName: PLAY,
      fromEmail: EMAIL,
      subject: "Automatic reply",
      body,
      receivedAt: RECEIVED,
      kind: "auto",
    });
  }

  it("dry run reports and writes nothing; --write stops and escalates", async () => {
    const prospectId = seed();
    // Stored as a plain auto-reply before the rules knew this phrasing.
    storeAuto("old-1", prospectId, "This person no longer works at Halyard.");

    const dry = await reclassifyAutoReplies({ sinceIso: "2026-10-21T00:00:00.000Z", write: false });
    expect(dry).toEqual([
      expect.objectContaining({ kind: "reply", reason: "left_company", action: "would stop 1" }),
    ]);
    expect(ledger.getCadence(prospectId, PLAY)?.status).toBe("active");
    expect(ledger.getInboxReplyAutoClassification("old-1")).toBeNull();

    const wrote = await reclassifyAutoReplies({
      sinceIso: "2026-10-21T00:00:00.000Z",
      write: true,
    });
    expect(wrote[0]).toMatchObject({ reason: "left_company", action: "stop 1" });
    expect(ledger.getCadence(prospectId, PLAY)?.status).toBe("bounced");
    expect(ledger.contactSuppressionFor(EMAIL)?.kind).toBe("auto_permanent");
  });

  it("holds an out-of-office and stops a policy-blocked sequence", async () => {
    const prospectId = seed();
    storeAuto("old-1", prospectId, "I am out of office until 14th December.");
    const other = ledger.upsertProspect({
      name: "Lee",
      email: "lee@tidewater.example",
      source: PLAY,
    });
    ledger.enrollCadence({
      prospectId: other,
      playName: PLAY,
      nextDueAt: "2026-11-06T09:00:00.000Z",
    });
    ledger.recordBounce({
      messageId: "dsn-1",
      recipient: "lee@tidewater.example",
      identityId: null,
      kind: "block",
      statusCode: "5.7.1",
      diagnostic: "policy",
      prospectId: other,
      bouncedAt: "2026-11-03T10:00:00.000Z",
    });

    const rows = await reclassifyAutoReplies({ sinceIso: "2026-10-21T00:00:00.000Z", write: true });
    expect(rows).toEqual([
      expect.objectContaining({
        reason: "out_of_office",
        returnDate: "2026-12-14",
        action: "hold 1 until 2026-12-16",
      }),
      expect.objectContaining({ kind: "block", reason: "blocked", action: "stop 1" }),
    ]);
    expect(ledger.getCadence(prospectId, PLAY)?.held_until).toBe("2026-12-16T00:00:00.000Z");
    const blocked = ledger.getCadence(other, PLAY)!;
    expect(blocked.status).toBe("bounced");
    expect(blocked.hold_reason).toBe("blocked");
  });
});
