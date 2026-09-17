import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyDraftSet, ReplyThread } from "@oneshot-gtm/shared-types";
const generate = vi.fn();
const improve = vi.fn();
const sdk = vi.fn();
const emailSend = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({ callLinkedIn: (...a: unknown[]) => sdk(...a) }));
vi.mock("../src/linkedin-sync.ts", () => ({ refreshLinkedInInbox: async () => {} }));
vi.mock("../src/api/replies-view.ts", () => ({ collectReplies: async () => ({ threads: [] }) }));
vi.mock("../src/api/inbox.ts", () => ({
  listInboxRoute: vi.fn(),
  draftReplyRoute: vi.fn(),
  saveDraftRoute: vi.fn(),
  steerRoute: vi.fn(),
  archiveInboxConversationRoute: vi.fn(),
  sendReplyRoute: (...a: unknown[]) => emailSend(...a),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  generateReplyOptions: (...a: unknown[]) => generate(...a),
  improveReplyOption: (...a: unknown[]) => improve(...a),
}));
const { getReplyReviewStore, getLinkedInInboxStore, getLedger, loadConfig, saveConfig } =
  await import("@oneshot-gtm/core");
const {
  replyGenerateRoute,
  replyDraftSaveRoute,
  replyImproveRoute,
  replySendRoute,
  replyStateRoute,
} = await import("../src/api/replies.ts");
const review = getReplyReviewStore();
const linkedin = getLinkedInInboxStore();
const req = (body: unknown, origin = "http://localhost:3030") =>
  new Request("http://localhost:3030/api/replies", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
const drafts = (): ReplyDraftSet => ({
  id: "generation",
  revision: 0,
  contextVersion: "context",
  read: "Question",
  originals: { direct: "Answer", technical: "Detail", warm: "Thanks" },
  edits: { direct: "My edited answer", technical: "Detail", warm: "Thanks" },
  moves: { direct: "answer", technical: "check", warm: "ask" },
  flags: { direct: [], technical: [], warm: [] },
  setFlags: [],
  selected: "direct",
  steer: "",
  generated: true,
});
function seed(channel: "email" | "linkedin" = "email") {
  const t: ReplyThread = {
    key: channel,
    channel,
    name: "Ada",
    company: null,
    address: "ada@example.com",
    subject: "Question",
    workspace: "default",
    prospectId: null,
    messages: [
      {
        id: "in",
        direction: "inbound",
        body: "How does it work?",
        at: "2026-09-17T12:00:00Z",
        human: true,
      },
    ],
    lastActivityAt: "2026-09-17T12:00:00Z",
    archivedAt: null,
    snoozedUntil: null,
    needsReply: true,
    canGenerate: true,
    canSend: true,
    contextVersion: "context",
    drafts: null,
    send: null,
  };
  if (channel === "linkedin") {
    t.accountKey = "wallet:account";
    t.conversationId = "conversation";
  } else
    t.email = {
      id: "in",
      fromEmail: "ada@example.com",
      fromRaw: "Ada",
      subject: "Question",
      body: "How does it work?",
      receivedAt: t.lastActivityAt,
      kind: "human",
      intent: null,
      intentReason: null,
      sourceIdentityId: "gmail:founder@example.com",
      sourceProvider: "gmail",
      threadId: "gmail-thread",
      messageId: "<in>",
      matched: null,
      thread: null,
    };
  review.upsert("test", t);
  return t;
}
beforeEach(() => {
  review.db.exec("DELETE FROM review_threads; DELETE FROM review_sends; DELETE FROM review_leases");
  linkedin.db.exec("DELETE FROM accounts; DELETE FROM conversations");
  linkedin.db.query("INSERT INTO accounts VALUES(?,?)").run(
    "wallet:account",
    JSON.stringify({
      key: "wallet:account",
      wallet: "wallet",
      workspace: "default",
      account: { id: "account", status: "connected", allowed_actions: ["read", "reply"] },
      sync: null,
      checkedAt: null,
      error: null,
    }),
  );
  saveConfig({
    ...loadConfig(),
    productBrief: "OneShot provides tools with payments.",
    founderVoice: "Plain and direct",
  });
  generate.mockReset().mockResolvedValue({
    drafts: { direct: "First", technical: "Second", warm: "Third" },
    read: "A question",
    moves: { direct: "answer", technical: "check", warm: "ask" },
    flags: { perVariant: { direct: [], technical: [], warm: [] }, set: [] },
  });
  improve.mockReset().mockResolvedValue("Improved current text");
  sdk.mockReset();
  emailSend
    .mockReset()
    .mockResolvedValue(Response.json({ sent: true, id: "email-send", costUsd: 0 }));
});
describe("reply options API", () => {
  it("returns three channel-aware options without replacing existing edits, then reuses accepted options", async () => {
    const t = seed();
    const saved = review.saveDrafts(t.key, drafts(), null);
    const cached = await replyGenerateRoute(req({ key: t.key }));
    expect(await cached.json()).toMatchObject({ id: "generation" });
    expect(generate).not.toHaveBeenCalled();
    const generated = await replyGenerateRoute(
      req({ key: t.key, force: true, steer: "No meeting ask" }),
    );
    expect(generated.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        steer: "No meeting ask",
        primaryBrief: "OneShot provides tools with payments.",
      }),
    );
    expect(review.get(t.key)?.drafts).toEqual(saved);
  });
  it("improves the current edited text and never writes it over a newer save", async () => {
    const t = seed();
    review.saveDrafts(t.key, drafts(), null);
    const response = await replyImproveRoute(
      req({
        key: t.key,
        variant: "direct",
        text: "My intentional changes",
        feedback: "Keep the question",
      }),
    );
    expect(response.status).toBe(200);
    expect(improve).toHaveBeenCalledWith(
      expect.anything(),
      "My intentional changes",
      "Answer",
      "Keep the question",
    );
    expect(review.get(t.key)?.drafts?.edits.direct).toBe("My edited answer");
  });
  it("rejects stale autosaves and cross-origin mutations", async () => {
    const t = seed();
    review.saveDrafts(t.key, drafts(), null);
    expect(
      (await replyDraftSaveRoute(req({ key: t.key, drafts: drafts(), expectedRevision: null })))
        .status,
    ).toBe(409);
    expect(
      (
        await replyStateRoute(
          req({ key: t.key, action: "snooze", observedReplyIds: ["in"] }, "https://evil.example"),
        )
      ).status,
    ).toBe(403);
    expect(
      (await replyStateRoute(req({ key: t.key, action: "snooze", observedReplyIds: [] }))).status,
    ).toBe(409);
  });
  it("sends only the selected saved email body with the original thread metadata", async () => {
    const t = seed();
    const d = drafts();
    d.selected = "technical";
    d.edits.technical = "My technical edit";
    review.saveDrafts(t.key, d, null);
    const response = await replySendRoute(
      req({ key: t.key, sendId: "1234567890123456", revision: 1 }),
    );
    expect(await response.json()).toMatchObject({
      status: "sent",
      body: "My technical edit",
      variant: "technical",
    });
    const forwarded = emailSend.mock.calls[0]![0] as Request;
    expect(await forwarded.json()).toMatchObject({
      body: "My technical edit",
      threadId: "gmail-thread",
      inReplyTo: "<in>",
      identityId: "gmail:founder@example.com",
    });
    await replySendRoute(req({ key: t.key, sendId: "1234567890123456", revision: 1 }));
    expect(emailSend).toHaveBeenCalledTimes(1);
  });
  it("allows retry after a definite email failure and reconciles uncertain mailbox delivery", async () => {
    const t = seed();
    review.saveDrafts(t.key, drafts(), null);
    emailSend.mockResolvedValueOnce(
      Response.json(
        { error: "Reply was not sent. Check mailbox settings and retry." },
        { status: 400 },
      ),
    );
    expect(
      await (
        await replySendRoute(req({ key: t.key, sendId: "1234567890123456", revision: 1 }))
      ).json(),
    ).toMatchObject({ status: "failed" });
    expect(review.get(t.key)?.drafts?.edits.direct).toBe("My edited answer");
    emailSend.mockResolvedValueOnce(
      Response.json({ error: "Delivery uncertain" }, { status: 400 }),
    );
    expect(
      await (
        await replySendRoute(req({ key: t.key, sendId: "2222222222222222", revision: 1 }))
      ).json(),
    ).toMatchObject({ status: "uncertain" });
    const attempt = vi.spyOn(getLedger().mailboxes, "attempt").mockReturnValue({
      id: "2222222222222222",
      status: "sent",
      error: null,
      message: { at: "2026-09-17T13:00:00Z" },
    } as never);
    try {
      expect(await (await replySendRoute(req({ key: t.key, check: true }))).json()).toMatchObject({
        status: "sent",
      });
      expect(review.get(t.key)?.drafts?.edits.direct).toBe("");
      expect(emailSend).toHaveBeenCalledTimes(2);
    } finally {
      attempt.mockRestore();
    }
  });
  it("keeps an accepted LinkedIn send pending across reloads, then confirms it without resending", async () => {
    const t = seed("linkedin");
    review.saveDrafts(t.key, drafts(), null);
    sdk
      .mockResolvedValueOnce({ request_id: "request-1", status: "processing" })
      .mockResolvedValueOnce({ status: "sent", sent_at: "2026-09-17T13:00:00Z" });
    const first = await replySendRoute(
      req({ key: t.key, sendId: "1234567890123456", revision: 1 }),
    );
    expect(await first.json()).toMatchObject({ status: "pending", requestId: "request-1" });
    expect(review.get(t.key)?.drafts?.edits.direct).toBe("My edited answer");
    const checked = await replySendRoute(req({ key: t.key, check: true }));
    expect(await checked.json()).toMatchObject({ status: "sent" });
    expect(sdk.mock.calls[1]![1]).toEqual({ kind: "wait", requestId: "request-1" });
    expect(review.get(t.key)?.drafts?.edits.direct).toBe("");
    expect(review.get(t.key)?.needsReply).toBe(false);
  });
  it("reuses the original idempotency key after an ambiguous submission and blocks new sends", async () => {
    const t = seed("linkedin");
    review.saveDrafts(t.key, drafts(), null);
    sdk
      .mockRejectedValueOnce(new Error("Network disconnected"))
      .mockResolvedValueOnce({ request_id: "request-2", status: "processing" });
    expect(
      await (
        await replySendRoute(req({ key: t.key, sendId: "1234567890123456", revision: 1 }))
      ).json(),
    ).toMatchObject({ status: "uncertain" });
    expect(
      (await replySendRoute(req({ key: t.key, sendId: "2222222222222222", revision: 1 }))).status,
    ).toBe(409);
    await replySendRoute(req({ key: t.key, check: true }));
    expect(sdk.mock.calls[0]![1]).toMatchObject({ idempotencyKey: "1234567890123456" });
    expect(sdk.mock.calls[1]![1]).toMatchObject({ idempotencyKey: "1234567890123456" });
  });
});
