import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertInboxDraftMock = vi.fn();
const clearInboxDraftMock = vi.fn();
const recordInboxSentMock = vi.fn();
const getInboxThreadsMock = vi.fn();
const listInboxMock = vi.fn();
const replyEmailMock = vi.fn();

const ledger = {
  upsertInboxDraft: upsertInboxDraftMock,
  clearInboxDraft: clearInboxDraftMock,
  recordInboxSent: recordInboxSentMock,
  getInboxThreads: getInboxThreadsMock,
  listAllCadences: () => [],
  getProspectByEmail: () => null,
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

// draftInboxReply isn't exercised here but the module imports it.
vi.mock("@oneshot-gtm/plays", () => ({ draftInboxReply: vi.fn() }));

const { listInboxRoute, saveDraftRoute, sendReplyRoute } = await import("../src/api/inbox.ts");

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
