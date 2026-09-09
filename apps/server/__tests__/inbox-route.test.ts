import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertInboxDraftMock = vi.fn();
const clearInboxDraftMock = vi.fn();
const recordInboxSentMock = vi.fn();
const getInboxThreadsMock = vi.fn();
const listInboxMock = vi.fn();
const replyEmailMock = vi.fn();
const setInboxDraftSteerMock = vi.fn();
const setInboxDraftBodyMock = vi.fn();

const recordProspectReplyMock = vi.fn(() => []);
const listProspectIdsWithRepliesMock = vi.fn((): number[] => []);
const listInboxRepliesForProspectMock = vi.fn((): unknown[] => []);
const listSequenceEventsForProspectMock = vi.fn((): unknown[] => []);
const recordInboxReplyMock = vi.fn(() => true);
const getProspectByIdMock = vi.fn((): unknown => null);
const listInboxReplyIntentsMock = vi.fn(() => new Map());
const listLatestOutcomeRecordedAtByProspectMock = vi.fn((): Map<number, string> => new Map());
// null by default (unmatched sender); tests override with mockReturnValueOnce
// to exercise the matched-prospect path (angle preservation, cadence rank).
const getProspectByEmailMock = vi.fn((): unknown => null);
const listCadencesForProspectMock = vi.fn((): unknown[] => []);
const notifySlackReplyReceivedMock = vi.fn(async () => {});
const notifySlackBounceRecordedMock = vi.fn(async () => {});
let knownProspect: { id: number } | null = null;

const ledger = {
  upsertInboxDraft: upsertInboxDraftMock,
  clearInboxDraft: clearInboxDraftMock,
  recordInboxSent: recordInboxSentMock,
  getInboxThreads: getInboxThreadsMock,
  listAllCadences: () => [],
  listRepliedProspectEmails: () => [],
  // v21 conversation machinery — empty by default; tests override with
  // mockReturnValueOnce (one-shot, so nothing leaks across tests).
  listProspectIdsWithReplies: listProspectIdsWithRepliesMock,
  listInboxRepliesForProspect: listInboxRepliesForProspectMock,
  listSequenceEventsForProspect: listSequenceEventsForProspectMock,
  recordInboxReply: recordInboxReplyMock,
  getProspectById: getProspectByIdMock,
  getProspectByEmail: getProspectByEmailMock,
  listCadencesForProspect: listCadencesForProspectMock,
  findProspectByEmail: () => knownProspect,
  recordProspectReply: recordProspectReplyMock,
  // issue #480: sentiment/intent, bulk-read for the list route's badge.
  listInboxReplyIntents: listInboxReplyIntentsMock,
  setInboxDraftSteer: setInboxDraftSteerMock,
  setInboxDraftBody: setInboxDraftBodyMock,
  // round-2 correction (#480): the nav-dot ack signal — empty by default.
  listLatestOutcomeRecordedAtByProspect: listLatestOutcomeRecordedAtByProspectMock,
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    isDraining: () => false,
    logEvent: () => {},
    loadConfig: () => ({ sendingDomain: "mysender.com" }),
    resolveIdentities: () => [{ id: "gmail:me@x.com", provider: "gmail", address: "me@x.com" }],
    listInbox: listInboxMock,
    // trackSend just runs the thunk and wraps its result the way the route expects.
    trackSend: async (fn: () => Promise<unknown>) => ({ result: await fn() }),
    replyEmail: replyEmailMock,
    notifySlackReplyReceived: notifySlackReplyReceivedMock,
    notifySlackBounceRecorded: notifySlackBounceRecordedMock,
  };
});

const draftInboxReplyMock = vi.fn();
// bodyCommitsTerms is the real (deterministic, no-LLM) implementation — the
// send gate's regex check is cheap enough not to need mocking, and mocking
// it to always-false would silently stop testing the gate at all.
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, draftInboxReply: draftInboxReplyMock };
});

// Research is unit-tested in reply-research.test.ts; here it's a seam.
const gatherReplyContextMock = vi.fn();
vi.mock("../src/api/_reply-research.ts", () => ({
  gatherReplyContext: gatherReplyContextMock,
}));

const { draftReplyRoute, listInboxRoute, saveDraftRoute, sendReplyRoute, steerRoute } =
  await import("../src/api/inbox.ts");

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3030", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("inbox route — persisted drafts & sent replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listInboxRoute annotates each email with its persisted thread", async () => {
    getInboxThreadsMock.mockReturnValue(
      new Map([
        [
          "t1",
          { draftBody: "saved draft", sent: [{ body: "sent1", sentAt: "2026-06-10T00:00:00Z" }] },
        ],
      ]),
    );
    listInboxMock.mockResolvedValue({
      emails: [
        {
          id: "e1",
          from: "Founder <founder@acme.com>",
          subject: "Re: hi",
          received_at: "2026-06-10T01:00:00Z",
          body: "hey",
          source_identity_id: "gmail:me@x.com",
          thread_id: "t1",
          message_id: "<m1>",
        },
      ],
    });

    const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
    const out = (await res.json()) as {
      replies: Array<{ thread: { draftBody: string | null; sent: { body: string }[] } | null }>;
    };
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]!.thread?.draftBody).toBe("saved draft");
    expect(out.replies[0]!.thread?.sent.map((s) => s.body)).toEqual(["sent1"]);
  });

  it("opportunistic capture notifies Slack for a new human reply, not an autoresponder", async () => {
    getInboxThreadsMock.mockReturnValue(new Map());
    knownProspect = { id: 42 };
    getProspectByEmailMock.mockReturnValue({
      id: 42,
      name: "Jane",
      company: "Acme",
      source: "cold",
    });
    listInboxMock.mockResolvedValue({
      emails: [
        {
          id: "human-1",
          from: "jane@acme.com",
          subject: "Re: hi",
          received_at: "2026-06-10T01:00:00Z",
          body: "sounds good, let's talk",
        },
        {
          id: "auto-1",
          from: "jane@acme.com",
          subject: "Automatic reply: out of office",
          received_at: "2026-06-10T02:00:00Z",
          body: "I am out of office until Monday.",
        },
      ],
    });

    try {
      const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
      expect(res.status).toBe(200);
      // Both emails are recorded (opportunistic capture persists everything
      // matched), but the Slack alert only fires for the human one — an
      // autoresponder is not a reply by classifyReply's own contract and must
      // not raise a false "Reply from ..." alert (round-1 correction, #71).
      expect(recordInboxReplyMock).toHaveBeenCalledTimes(2);
      expect(notifySlackReplyReceivedMock).toHaveBeenCalledTimes(1);
      expect(notifySlackReplyReceivedMock).toHaveBeenCalledWith(
        expect.objectContaining({ from_email: "jane@acme.com", kind: "human" }),
      );
    } finally {
      knownProspect = null;
      getProspectByEmailMock.mockReturnValue(null);
    }
  });

  // issue #71 round-6/7 review finding: this opportunistic capture and the
  // scheduler's pollInboxReplies() both call recordInboxReply with the same
  // id (INSERT OR IGNORE), so whichever one wins the first-sight race is the
  // only one that can fire a notification. Before this fix, inbox.ts never
  // called notifySlackBounceRecorded at all for a dead-mailbox autoresponder,
  // so a GET /api/inbox that raced ahead of the scheduler's poll silently
  // dropped the bounce alert forever (the scheduler's later poll then sees
  // isNewReply=false and also skips it).
  it("opportunistic capture notifies a Slack bounce alert for a first-seen dead-mailbox autoresponder", async () => {
    getInboxThreadsMock.mockReturnValue(new Map());
    knownProspect = { id: 43 };
    getProspectByEmailMock.mockReturnValue({
      id: 43,
      name: "Dead Mailbox",
      company: "Ghostco",
      source: "cold",
    });
    listInboxMock.mockResolvedValue({
      emails: [
        {
          id: "auto-permanent-1",
          from: "retired@ghostco.com",
          subject: "Delivery has failed",
          received_at: "2026-06-10T01:00:00Z",
          body: "This person is no longer with the company.",
          auto_submitted: true,
        },
      ],
    });

    try {
      const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
      expect(res.status).toBe(200);
      expect(notifySlackBounceRecordedMock).toHaveBeenCalledTimes(1);
      expect(notifySlackBounceRecordedMock).toHaveBeenCalledWith({
        recipient: "retired@ghostco.com",
        kind: "auto_permanent",
        status_code: null,
      });
      // Not a human reply — must not also fire the reply-received alert.
      expect(notifySlackReplyReceivedMock).not.toHaveBeenCalled();
    } finally {
      knownProspect = null;
      getProspectByEmailMock.mockReturnValue(null);
    }
  });

  it("opportunistic capture does not re-fire a bounce alert on an already-recorded email (isNew=false)", async () => {
    getInboxThreadsMock.mockReturnValue(new Map());
    knownProspect = { id: 44 };
    getProspectByEmailMock.mockReturnValue({
      id: 44,
      name: "Dead Mailbox",
      company: "Ghostco",
      source: "cold",
    });
    recordInboxReplyMock.mockReturnValueOnce(false);
    listInboxMock.mockResolvedValue({
      emails: [
        {
          id: "auto-permanent-2",
          from: "retired2@ghostco.com",
          subject: "Delivery has failed",
          received_at: "2026-06-10T01:00:00Z",
          body: "This person is no longer with the company.",
          auto_submitted: true,
        },
      ],
    });

    try {
      const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
      expect(res.status).toBe(200);
      expect(notifySlackBounceRecordedMock).not.toHaveBeenCalled();
    } finally {
      knownProspect = null;
      getProspectByEmailMock.mockReturnValue(null);
    }
  });

  it("assembles conversations: outreach + inbound replies + manual sends, in time order", async () => {
    listInboxMock.mockResolvedValue({ emails: [] });
    getInboxThreadsMock.mockReturnValue(
      new Map([
        [
          "t1",
          { draftBody: "wip", sent: [{ body: "my answer", sentAt: "2026-08-25T23:00:00.000Z" }] },
        ],
      ]),
    );
    listProspectIdsWithRepliesMock.mockReturnValueOnce([7]);
    getProspectByIdMock.mockReturnValueOnce({
      id: 7,
      name: "Coder",
      email: "coder@x.example",
      company: "OGs",
      source: "stack-consolidation",
    });
    listInboxRepliesForProspectMock.mockReturnValueOnce([
      {
        id: "m1",
        thread_key: "t1",
        prospect_id: 7,
        play_name: "stack-consolidation",
        from_email: "coder@x.example",
        subject: "Re: stack thing",
        body: "It's sdk maintenance",
        received_at: "2026-08-25T22:38:09.000Z",
        source_identity_id: "gmail:me@x.com",
        thread_id: "t1",
        message_id: "<m1@mail>",
      },
    ]);
    listSequenceEventsForProspectMock.mockReturnValueOnce([
      {
        prospect_id: 7,
        play_name: "stack-consolidation",
        step_index: 0,
        channel: "email",
        status: "replied",
        metadata_json: JSON.stringify({ subject: "stack thing", body: "outreach body" }),
        created_at: "2026-08-24 10:00:00",
      },
    ]);

    const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
    const out = (await res.json()) as {
      conversations: Array<{
        prospectId: number;
        draftBody: string | null;
        items: Array<{ kind: string; at: string; body: string | null }>;
      }>;
    };
    expect(out.conversations).toHaveLength(1);
    const conv = out.conversations[0]!;
    expect(conv.prospectId).toBe(7);
    // Saved composer draft rides along for the newest inbound's thread.
    expect(conv.draftBody).toBe("wip");
    // Timeline order: outreach (SQLite timestamp, normalized) → their reply → our manual answer.
    expect(conv.items.map((i) => i.kind)).toEqual(["outreach", "reply", "sent"]);
    expect(conv.items[0]!.body).toBe("outreach body");
    expect(conv.items[1]!.body).toBe("It's sdk maintenance");
    expect(conv.items[2]!.body).toBe("my answer");
  });

  it.each([
    [undefined, true],
    ["2026-09-06 10:00:00", true],
    ["2026-09-07 10:00:01", false],
    ["2026-09-07 10:00:00", true],
  ])("awaitingReply with outcome %s is %s", async (recordedAt, awaitingReply) => {
    listInboxMock.mockResolvedValue({ emails: [] });
    getInboxThreadsMock.mockReturnValue(new Map());
    listProspectIdsWithRepliesMock.mockReturnValueOnce([7]);
    getProspectByIdMock.mockReturnValueOnce({
      id: 7,
      name: "Coder",
      email: "coder@x.example",
      company: "OGs",
      source: "show-hn",
    });
    listInboxRepliesForProspectMock.mockReturnValueOnce([
      {
        id: "m1",
        thread_key: "t1",
        prospect_id: 7,
        received_at: "2026-09-07T10:00:00.000Z",
        intent: "interested",
      },
    ]);
    listLatestOutcomeRecordedAtByProspectMock.mockReturnValueOnce(
      new Map(recordedAt == null ? [] : [[7, recordedAt]]),
    );

    const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
    const out = await res.json();
    expect(out.conversations).toHaveLength(1);
    expect(out.conversations[0].awaitingReply).toBe(awaitingReply);
    expect(listLatestOutcomeRecordedAtByProspectMock).toHaveBeenCalledTimes(1);
  });

  it("saveDraftRoute persists the draft via upsertInboxDraft", async () => {
    const res = await saveDraftRoute(
      post("/api/inbox/draft", {
        threadKey: "t1",
        inboundEmailId: "e1",
        toEmail: "founder@acme.com",
        subject: "Re: hi",
        identityId: "gmail:me@x.com",
        body: "draft body",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, status: null });
    expect(upsertInboxDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: "t1", inboundEmailId: "e1", body: "draft body" }),
    );
  });

  it("saveDraftRoute rejects missing required fields", async () => {
    const res = await saveDraftRoute(post("/api/inbox/draft", { threadKey: "t1" }));
    expect(res.status).toBe(400);
  });

  it("saveDraftRoute clears the draft when the body is emptied", async () => {
    const res = await saveDraftRoute(
      post("/api/inbox/draft", {
        threadKey: "t1",
        inboundEmailId: "e1",
        toEmail: "founder@acme.com",
        subject: "Re: hi",
        identityId: "gmail:me@x.com",
        body: "   ",
      }),
    );
    expect(res.status).toBe(200);
    expect(clearInboxDraftMock).toHaveBeenCalledWith("t1");
    expect(upsertInboxDraftMock).not.toHaveBeenCalled();
  });

  it("sendReplyRoute records the sent reply body after a successful send", async () => {
    replyEmailMock.mockResolvedValue({ request_id: "req-1", cost: 0 });
    const res = await sendReplyRoute(
      post("/api/inbox/reply", {
        to: "founder@acme.com",
        subject: "Re: hi",
        body: "the reply we sent",
        identityId: "gmail:me@x.com",
        threadKey: "t1",
        threadId: "t1",
        inReplyTo: "<m1>",
      }),
    );
    expect(res.status).toBe(200);
    expect(recordInboxSentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: "t1",
        toEmail: "founder@acme.com",
        body: "the reply we sent",
        requestId: "req-1",
      }),
    );
  });

  it("sendReplyRoute records the reply against the prospect it answers", async () => {
    // Answering someone is proof they replied — the human is the detector of
    // last resort when the background poll missed it.
    knownProspect = { id: 7 };
    replyEmailMock.mockResolvedValue({ request_id: "req-2", cost: 0 });
    try {
      const res = await sendReplyRoute(
        post("/api/inbox/reply", {
          to: "founder@acme.com",
          subject: "Re: hi",
          body: "thanks, yes",
          identityId: "gmail:me@x.com",
          threadKey: "t2",
        }),
      );
      expect(res.status).toBe(200);
      expect(recordProspectReplyMock).toHaveBeenCalledWith(7, { subject: "Re: hi" });
    } finally {
      knownProspect = null;
    }
  });

  it("sendReplyRoute still succeeds when recording the reply throws", async () => {
    knownProspect = { id: 8 };
    recordProspectReplyMock.mockImplementationOnce(() => {
      throw new Error("ledger locked");
    });
    replyEmailMock.mockResolvedValue({ request_id: "req-3", cost: 0 });
    try {
      const res = await sendReplyRoute(
        post("/api/inbox/reply", {
          to: "founder@acme.com",
          subject: "Re: hi",
          body: "x",
          identityId: "gmail:me@x.com",
          threadKey: "t3",
        }),
      );
      expect(res.status).toBe(200);
      expect(recordInboxSentMock).toHaveBeenCalled();
    } finally {
      knownProspect = null;
    }
  });

  it("sendReplyRoute requires threadKey", async () => {
    const res = await sendReplyRoute(
      post("/api/inbox/reply", {
        to: "founder@acme.com",
        subject: "Re: hi",
        body: "x",
        identityId: "gmail:me@x.com",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("inbox route — window honesty & empty-body drafting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInboxThreadsMock.mockReturnValue(new Map());
  });

  it("passes listInbox's has_more through instead of hardcoding false", async () => {
    listInboxMock.mockResolvedValue({ emails: [], has_more: true });
    const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
    const out = (await res.json()) as { hasMore: boolean };
    // The UI renders this as a "+" on its counts — a clamped window must never
    // be presented as the whole mailbox.
    expect(out.hasMore).toBe(true);
  });

  it("reports hasMore false when the window really is everything", async () => {
    listInboxMock.mockResolvedValue({ emails: [], has_more: false });
    const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
    expect(((await res.json()) as { hasMore: boolean }).hasMore).toBe(false);
  });

  it("draft-reply 400s legibly on a bodyless email", async () => {
    const res = await draftReplyRoute(
      post("/api/inbox/draft-reply", {
        fromEmail: "founder@acme.com",
        subject: "Re: hi",
        body: "",
      }),
    );
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string };
    expect(out.error).toMatch(/no body/i);
  });
});

describe("inbox route — research-grounded drafting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInboxThreadsMock.mockReturnValue(new Map());
    gatherReplyContextMock.mockResolvedValue({
      dossier: "researched dossier",
      threadSent: [{ body: "sent earlier", sentAt: "2026-08-20" }],
      costUsd: 0.06,
      researched: true,
    });
    draftInboxReplyMock.mockResolvedValue({ body: "the draft", flags: [] });
  });

  it("passes research context into draftInboxReply and reports the spend", async () => {
    const res = await draftReplyRoute(
      post("/api/inbox/draft-reply", {
        fromEmail: "aladdin@aliyev.site",
        subject: "Re: x",
        body: "tell me about payments",
        id: "e1",
        threadId: "t1",
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      body: string;
      costUsd: number;
      researched: boolean;
      flags: string[];
      needsDecision: boolean;
    };
    expect(out).toEqual({
      body: "the draft",
      costUsd: 0.06,
      researched: true,
      flags: [],
      needsDecision: false,
    });
    expect(gatherReplyContextMock).toHaveBeenCalledWith({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: "t1",
      excludeId: "e1",
      skipPaid: false, // a human reply — the paid tier stays available
    });
    expect(draftInboxReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dossier: "researched dossier",
        threadSent: [{ body: "sent earlier", sentAt: "2026-08-20" }],
      }),
    );
  });

  it("still drafts when research itself throws", async () => {
    gatherReplyContextMock.mockRejectedValue(new Error("research exploded"));
    const res = await draftReplyRoute(
      post("/api/inbox/draft-reply", { fromEmail: "a@b.dev", subject: "s", body: "hi" }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { body: string; costUsd: number };
    expect(out.body).toBe("the draft");
    expect(out.costUsd).toBe(0);
    expect(draftInboxReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ dossier: null, threadSent: [] }),
    );
  });

  it("preserves the matched prospect's angle_json when research throws (finding PRRT_kwDOSKzrBs6gZ7Qs)", async () => {
    getProspectByEmailMock.mockReturnValueOnce({
      id: 9,
      name: "Ada",
      company: "Acme",
      source: "cold",
      angle_json: '{"hook":"already synthesized"}',
    });
    listCadencesForProspectMock.mockReturnValueOnce([]);
    gatherReplyContextMock.mockRejectedValue(new Error("research exploded"));
    const res = await draftReplyRoute(
      post("/api/inbox/draft-reply", { fromEmail: "ada@acme.com", subject: "s", body: "hi" }),
    );
    expect(res.status).toBe(200);
    expect(draftInboxReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ dossier: null, angleJson: '{"hook":"already synthesized"}' }),
    );
  });
});

describe("steerRoute — persists the generated redraft (round-1 correction, #480)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInboxThreadsMock.mockReturnValue(new Map());
    gatherReplyContextMock.mockResolvedValue({
      dossier: null,
      threadSent: [],
      priorInbound: [],
      costUsd: 0,
      researched: false,
    });
  });

  it("writes the generated body back to inbox_drafts, not just the steer note", async () => {
    draftInboxReplyMock.mockResolvedValue({ body: "the redraft", flags: [] });
    const res = await steerRoute(
      post("/api/inbox/steer", {
        fromEmail: "founder@acme.com",
        subject: "Re: hi",
        body: "their message",
        id: "e1",
        threadKey: "t1",
        steer: "mention pricing is public",
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { body: string; needsDecision: boolean };
    expect(out.body).toBe("the redraft");
    // The bug: steerRoute persisted the steer instruction but never the
    // generated body, so the client-side autosave (gated on a body diff from
    // the last SAVED value) never fired and a refresh lost the redraft.
    expect(setInboxDraftBodyMock).toHaveBeenCalledWith("t1", "the redraft", null);
  });

  it("marks the persisted body needs_decision when the redraft commits terms", async () => {
    draftInboxReplyMock.mockResolvedValue({ body: "20% discount, deal", flags: ["commits-terms"] });
    const res = await steerRoute(
      post("/api/inbox/steer", {
        fromEmail: "founder@acme.com",
        subject: "Re: hi",
        body: "their message",
        id: "e1",
        threadKey: "t1",
        steer: "offer a discount",
      }),
    );
    expect(res.status).toBe(200);
    expect(setInboxDraftBodyMock).toHaveBeenCalledWith(
      "t1",
      "20% discount, deal",
      "needs_decision",
    );
  });

  it("preserves the matched prospect's angle_json when research throws (finding PRRT_kwDOSKzrBs6gZ7Qs)", async () => {
    getProspectByEmailMock.mockReturnValueOnce({
      id: 10,
      name: "Ada",
      company: "Acme",
      source: "cold",
      angle_json: '{"hook":"steer path angle"}',
    });
    listCadencesForProspectMock.mockReturnValueOnce([]);
    gatherReplyContextMock.mockRejectedValue(new Error("research exploded"));
    draftInboxReplyMock.mockResolvedValue({ body: "the redraft", flags: [] });
    const res = await steerRoute(
      post("/api/inbox/steer", {
        fromEmail: "ada@acme.com",
        subject: "Re: hi",
        body: "their message",
        id: "e1",
        threadKey: "t1",
        steer: "mention pricing is public",
      }),
    );
    expect(res.status).toBe(200);
    expect(draftInboxReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ dossier: null, angleJson: '{"hook":"steer path angle"}' }),
    );
  });
});
