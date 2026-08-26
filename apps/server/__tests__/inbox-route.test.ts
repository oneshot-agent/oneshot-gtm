import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertInboxDraftMock = vi.fn();
const clearInboxDraftMock = vi.fn();
const recordInboxSentMock = vi.fn();
const getInboxThreadsMock = vi.fn();
const listInboxMock = vi.fn();
const replyEmailMock = vi.fn();

const recordProspectReplyMock = vi.fn(() => []);
const listProspectIdsWithRepliesMock = vi.fn((): number[] => []);
const listInboxRepliesForProspectMock = vi.fn((): unknown[] => []);
const listSequenceEventsForProspectMock = vi.fn((): unknown[] => []);
const recordInboxReplyMock = vi.fn(() => true);
const getProspectByIdMock = vi.fn((): unknown => null);
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
  getProspectByEmail: () => null,
  findProspectByEmail: () => knownProspect,
  recordProspectReply: recordProspectReplyMock,
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
  };
});

const draftInboxReplyMock = vi.fn();
vi.mock("@oneshot-gtm/plays", () => ({ draftInboxReply: draftInboxReplyMock }));

// Research is unit-tested in reply-research.test.ts; here it's a seam.
const gatherReplyContextMock = vi.fn();
vi.mock("../src/api/_reply-research.ts", () => ({
  gatherReplyContext: gatherReplyContextMock,
}));

const { draftReplyRoute, listInboxRoute, saveDraftRoute, sendReplyRoute } =
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
    expect(await res.json()).toEqual({ saved: true });
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
    draftInboxReplyMock.mockResolvedValue({ body: "the draft" });
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
    const out = (await res.json()) as { body: string; costUsd: number; researched: boolean };
    expect(out).toEqual({ body: "the draft", costUsd: 0.06, researched: true });
    expect(gatherReplyContextMock).toHaveBeenCalledWith({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: "t1",
      excludeId: "e1",
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
});
