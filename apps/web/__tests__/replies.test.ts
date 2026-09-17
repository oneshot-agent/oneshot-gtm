import { describe, expect, it } from "vitest";
import { emailThreads, type InboxReplyView, type ReplyThread } from "@oneshot-gtm/shared-types";
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
