import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";
import type { MailboxMessage } from "../../../packages/core/src/mailbox-store.ts";

let ledger: Ledger;
vi.mock("@oneshot-gtm/core", async (original) => ({
  ...(await original<typeof import("@oneshot-gtm/core")>()),
  getLedger: () => ledger,
  mailboxHealth: () => [
    {
      identityId: "smartlead:me@example.com",
      address: "me@example.com",
      status: "connected",
      lastSyncAt: "2026-09-11T00:00:00Z",
      error: null,
      backfillRemaining: false,
      messages: 1,
    },
  ],
}));
const { mailboxInboxView, mailboxStateRoute, mailboxMatchRoute } =
  await import("../src/api/mailboxes.ts");
const message: MailboxMessage = {
  id: "mailbox:message",
  identityId: "smartlead:me@example.com",
  threadKey: "mailbox:thread",
  messageId: "<inbound@example.com>",
  references: [],
  gmailThreadId: null,
  from: "sender@example.org",
  to: ["me@example.com"],
  replyTo: null,
  subject: "Question",
  body: "Tell me more",
  at: "2026-09-11T00:00:00Z",
  direction: "inbound",
  kind: "human",
  autoSubmitted: null,
  prospectId: null,
};
function request(body: unknown, origin = "http://localhost:3031") {
  return new Request("http://localhost/api/inbox/thread-state", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  ledger = new Ledger(":memory:");
  ledger.mailboxes.put(message);
});
afterEach(() => ledger.close());

it("returns durable unmatched threads, drafts, and receiving health", () => {
  ledger.upsertInboxDraft({
    threadKey: message.threadKey,
    inboundEmailId: message.id,
    toEmail: message.from,
    subject: message.subject,
    identityId: message.identityId,
    body: "draft",
  });
  const view = mailboxInboxView();
  expect(view.mailboxThreads?.[0]).toMatchObject({
    prospectId: null,
    unread: true,
    reply: { thread: { draftBody: "draft" }, sourceProvider: "smartlead" },
  });
  expect(view.mailboxes?.[0]?.status).toBe("connected");
  expect(JSON.stringify(view)).not.toContain("password");
});

it("archives and restores an unmatched thread without needing a prospect", async () => {
  const archive = await mailboxStateRoute(
    request({
      threadKey: message.threadKey,
      observedReplyIds: [message.id],
      read: true,
      archived: true,
    }),
  );
  expect(archive.status).toBe(200);
  expect(ledger.mailboxes.threadState(message.threadKey)).toMatchObject({
    unread: false,
    archivedAt: expect.any(String),
  });
  const restore = await mailboxStateRoute(
    request({ threadKey: message.threadKey, observedReplyIds: [], archived: false }),
  );
  expect(restore.status).toBe(200);
  expect(ledger.mailboxes.threadState(message.threadKey).archivedAt).toBeNull();
});

it("blocks cross-origin state changes and rejects stale archive snapshots", async () => {
  expect(
    (
      await mailboxStateRoute(
        request(
          { threadKey: message.threadKey, observedReplyIds: [message.id], archived: true },
          "https://evil.example",
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await mailboxStateRoute(
        request({ threadKey: message.threadKey, observedReplyIds: [], archived: true }),
      )
    ).status,
  ).toBe(409);
  expect(ledger.mailboxes.threadState(message.threadKey).archivedAt).toBeNull();
});

it("matches a thread to an existing workspace prospect and rejects unknown prospects", async () => {
  const id = ledger.upsertProspect({ email: "known@example.org", name: "Known" });
  expect(
    (await mailboxMatchRoute(request({ threadKey: message.threadKey, email: "KNOWN@example.org" })))
      .status,
  ).toBe(200);
  expect(mailboxInboxView().mailboxThreads?.[0]?.prospectId).toBe(id);
  expect(
    (
      await mailboxMatchRoute(
        request({ threadKey: message.threadKey, email: "foreign@example.org" }),
      )
    ).status,
  ).toBe(400);
});
