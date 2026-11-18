import { describe, expect, it } from "vitest";
import {
  emailThreads,
  type ConversationView,
  type InboxReplyView,
  type ReplyThread,
} from "@oneshot-gtm/shared-types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReplyRowLabel } from "../src/components/ReplyRowLabel.tsx";
import {
  replyHasLabel,
  replyInTab,
  replyInView,
  replyLabelOptions,
  replyNeedsAttention,
} from "../src/lib/replies.ts";

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
  it("the Needs reply tab holds exactly the inbox threads waiting on an answer", () => {
    const base = { archivedAt: null, snoozedUntil: null, drafts: null } as ReplyThread;
    const waiting = { ...base, needsReply: true };
    const answered = { ...base, needsReply: false };
    const archived = { ...waiting, archivedAt: new Date().toISOString() };
    expect(replyInTab(waiting, "needs-reply")).toBe(true);
    expect(replyInTab(answered, "needs-reply")).toBe(false);
    expect(replyInTab(archived, "needs-reply")).toBe(false);
    expect(replyInTab(answered, "inbox")).toBe(true);
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

describe("reply label filter", () => {
  const interested = { intent: "interested" } as const;
  const notNow = { intent: "not_now" } as const;
  const none = { intent: null };
  it("matches one label, the positive group, unlabelled threads, or everything", () => {
    expect(replyHasLabel(interested, "interested")).toBe(true);
    expect(replyHasLabel(notNow, "interested")).toBe(false);
    expect(replyHasLabel(interested, "positive")).toBe(true);
    expect(replyHasLabel(notNow, "positive")).toBe(false);
    expect(replyHasLabel(none, "positive")).toBe(false);
    expect(replyHasLabel(none, "unlabelled")).toBe(true);
    expect(replyHasLabel(interested, "unlabelled")).toBe(false);
    expect([interested, notNow, none].every((t) => replyHasLabel(t, "all"))).toBe(true);
  });
  it("counts each option and keeps only labels someone has, plus the selected one", () => {
    const threads = [interested, interested, notNow, none];
    const options = replyLabelOptions(threads, "meeting");
    expect(options.map((o) => [o.value, o.count])).toEqual([
      ["all", 4],
      ["positive", 2],
      ["interested", 2],
      ["meeting", 0],
      ["not_now", 1],
      ["unlabelled", 1],
    ]);
    expect(options.find((o) => o.value === "interested")?.title).toBe("Interested");
  });
  it("email threads carry the reply label on both build paths", () => {
    const reply: InboxReplyView = {
      id: "r1",
      kind: "human",
      intent: "interested",
      intentReason: null,
      intentReview: true,
      fromEmail: "ada@example.com",
      fromRaw: "Ada",
      subject: "Hi",
      receivedAt: "2026-09-17T12:00:00Z",
      body: "Tell me more",
      sourceIdentityId: "gmail:me@example.com",
      sourceProvider: "gmail",
      threadId: "t1",
      messageId: "<r1>",
      matched: null,
      thread: null,
    };
    const [grouped] = emailThreads({ replies: [reply], hasMore: false }, "test");
    expect(grouped).toMatchObject({ intent: "interested", intentReview: true });
    const conversation = {
      prospectId: 1,
      name: "Ada",
      company: null,
      email: "ada@example.com",
      archivedAt: null,
      playName: null,
      cadenceStatus: null,
      lastActivityAt: "2026-09-17T12:00:00Z",
      draftBody: null,
      steer: null,
      status: null,
      intent: "meeting",
      awaitingReply: true,
      items: [
        {
          kind: "reply",
          id: "c1",
          threadKey: "t2",
          sourceIdentityId: "gmail:me@example.com",
          threadId: "t2",
          messageId: "<c1>",
          at: "2026-09-17T12:00:00Z",
          subject: "Hi",
          body: "Let's meet",
          replyKind: "human",
          intent: "meeting",
          intentReview: true,
        },
      ],
    } satisfies ConversationView;
    const [fallback] = emailThreads(
      { replies: [], conversations: [conversation], hasMore: false },
      "test",
    );
    expect(fallback).toMatchObject({ intent: "meeting", intentReview: true });
    const [unlabelled] = emailThreads(
      { replies: [{ ...reply, intent: null, intentReview: undefined }], hasMore: false },
      "test",
    );
    expect(unlabelled).toMatchObject({ intent: null, intentReview: false });
  });
  it("a conversation row shows its label, and nothing before one is set", () => {
    const row = renderToStaticMarkup(
      createElement(ReplyRowLabel, { thread: { intent: "interested", intentReview: true } }),
    );
    expect(row).toContain("Interested");
    expect(row).toContain("check label");
    expect(renderToStaticMarkup(createElement(ReplyRowLabel, { thread: { intent: null } }))).toBe(
      "",
    );
  });
});
