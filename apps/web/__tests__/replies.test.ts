import { describe, expect, it } from "vitest";
import {
  emailThreads,
  type ConversationView,
  type InboxReplyView,
  type ReplyThread,
} from "@oneshot-gtm/shared-types";
import { replyInView, replyNeedsAttention } from "../src/lib/replies.ts";

describe("unified reply views", () => {
  it("removes snoozed conversations from attention and restores them when due", () => {
    const t = {
      archivedAt: null,
      snoozedUntil: new Date(Date.now() + 86400_000).toISOString(),
      needsReply: true,
      drafts: null,
    } as ReplyThread;
    expect(replyInView(t, "snoozed")).toBe(true);
    expect(replyNeedsAttention(t)).toBe(false);
    expect(replyInView(t, "inbox", Date.now() + 2 * 86400_000)).toBe(true);
    t.snoozedUntil = null;
    expect(replyNeedsAttention(t)).toBe(true);
    t.archivedAt = new Date().toISOString();
    expect(replyNeedsAttention(t)).toBe(false);
  });
  it("groups unmatched Gmail replies by identity and thread, retaining sent history", () => {
    const r: InboxReplyView = {
      id: "one",
      kind: "human",
      intent: null,
      intentReason: null,
      fromEmail: "ada@example.com",
      fromRaw: "Ada",
      subject: "Question",
      receivedAt: "2026-09-17T12:00:00Z",
      body: "First",
      sourceIdentityId: "gmail:me@example.com",
      sourceProvider: "gmail",
      threadId: "thread",
      messageId: "<one>",
      matched: null,
      thread: null,
    };
    const rows = emailThreads(
      {
        replies: [
          r,
          {
            ...r,
            id: "two",
            receivedAt: "2026-09-17T13:00:00Z",
            body: "Second",
            thread: {
              draftBody: "My edit",
              sent: [{ body: "Answer", sentAt: "2026-09-17T14:00:00Z" }],
              steer: null,
              status: null,
            },
          },
        ],
        hasMore: false,
      },
      "test",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messages).toHaveLength(3);
    expect(rows[0]!.needsReply).toBe(false);
    expect(rows[0]!.email?.thread?.draftBody).toBe("My edit");
  });
});

describe("email subject identity", () => {
  const conversation: ConversationView = {
    prospectId: 673,
    name: "Boardy Boardman",
    company: "Boardy",
    email: "boardy@example.test",
    archivedAt: null,
    playName: null,
    cadenceStatus: null,
    lastActivityAt: "2026-09-24T12:00:00Z",
    draftBody: null,
    steer: null,
    status: null,
    intent: null,
    awaitingReply: true,
    items: ["first", "second"].map((id) => ({
      kind: "reply",
      id,
      threadKey: id,
      sourceIdentityId: "gmail:demo",
      threadId: id,
      messageId: id,
      at: "2026-09-24T12:00:00Z",
      subject: "Introduction to Tushar Nandy",
      body: "Meet Tushar Nandy, who is building a new product.",
      replyKind: "human",
      intent: null,
    })),
  };
  it("keeps Boardy as the sender and marks multiple threads as latest subject", () => {
    const [t] = emailThreads(
      { replies: [], conversations: [conversation], hasMore: false },
      "test",
    );
    expect(t).toMatchObject({
      name: "Boardy Boardman",
      subject: "Introduction to Tushar Nandy",
      combinedEmailHistory: true,
    });
    expect(t?.messages[0]?.body).toContain("Tushar Nandy");
  });
  it("uses provider identity as well as thread ID to distinguish threads", () => {
    const c = structuredClone(conversation);
    for (const item of c.items) if (item.kind === "reply") item.threadId = "same";
    const build = () =>
      emailThreads({ replies: [], conversations: [c], hasMore: false }, "test")[0];
    expect(build()?.combinedEmailHistory).toBe(false);
    if (c.items[1]?.kind === "reply") c.items[1].sourceIdentityId = "gmail:other";
    expect(build()?.combinedEmailHistory).toBe(true);
  });
  it("uses saved thread keys when legacy replies lack provider thread IDs", () => {
    const c = structuredClone(conversation);
    for (const item of c.items)
      if (item.kind === "reply") {
        item.threadId = null;
        item.threadKey = "legacy-thread";
      }
    expect(
      emailThreads({ replies: [], conversations: [c], hasMore: false }, "test")[0]
        ?.combinedEmailHistory,
    ).toBe(false);
  });
});
