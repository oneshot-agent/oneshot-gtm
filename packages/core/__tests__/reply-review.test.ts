import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ReplyReviewStore } from "../src/reply-review-store.ts";
import type { ReplyDraftSet, ReplyThread } from "@oneshot-gtm/shared-types";

let store: ReplyReviewStore;
let path: string;
const now = Date.parse("2026-09-17T12:00:00Z");
function thread(channel: "email" | "linkedin" = "email"): ReplyThread {
  return {
    key: `${channel}:thread`,
    channel,
    name: "Ada",
    company: null,
    address: "ada@example.com",
    subject: "Question",
    workspace: "default",
    prospectId: 1,
    messages: [
      {
        id: "in-1",
        direction: "inbound",
        human: true,
        body: "How does this work?",
        at: new Date(now - 1000).toISOString(),
      },
    ],
    lastActivityAt: new Date(now - 1000).toISOString(),
    archivedAt: null,
    snoozedUntil: null,
    needsReply: true,
    canSend: true,
    canGenerate: true,
    contextVersion: "v1",
    drafts: null,
    send: null,
  };
}
function draft(): ReplyDraftSet {
  return {
    id: "draft-1",
    revision: 0,
    contextVersion: "v1",
    read: "They have a question",
    originals: { direct: "Answer", technical: "Detail", warm: "Thanks" },
    edits: { direct: "Edited answer", technical: "Detail", warm: "Thanks" },
    selected: "direct",
    moves: { direct: "answer", technical: "check", warm: "ask" },
    flags: { direct: [], technical: [], warm: [] },
    setFlags: [],
    steer: "Keep it short",
    generated: true,
  };
}
beforeEach(() => {
  path = join(process.env.ONESHOT_GTM_SHARED!, `${randomUUID()}.sqlite`);
  store = new ReplyReviewStore(path);
});
afterEach(() => store.close());

describe.each(["email", "linkedin"] as const)("%s review state", (channel) => {
  it("persists five-day snooze and drafts across restarts, with read-time expiry", () => {
    const t = thread(channel);
    store.upsert(channel, t);
    store.saveDrafts(t.key, draft(), null);
    const snoozed = store.setState(t.key, "snooze", ["in-1"], now);
    expect(snoozed.snoozedUntil).toBe("2026-09-22T12:00:00.000Z");
    store.close();
    store = new ReplyReviewStore(path);
    expect(store.get(t.key, now + 1)?.snoozedUntil).not.toBeNull();
    expect(store.get(t.key, now + 5 * 86400_000)?.snoozedUntil).toBeNull();
    expect(store.get(t.key, now + 5 * 86400_000)?.drafts?.edits.direct).toBe("Edited answer");
  });
  it("does not wake on outbound, historical imports, automatic messages, or edits", () => {
    const t = thread(channel);
    store.upsert(channel, t);
    store.setState(t.key, "snooze", ["in-1"], now);
    t.messages[0]!.body = "Edited question";
    t.messages.push(
      {
        id: "out",
        direction: "outbound",
        human: true,
        body: "Reply",
        at: new Date(now + 1000).toISOString(),
      },
      {
        id: "old",
        direction: "inbound",
        human: true,
        body: "History",
        at: new Date(now - 50000).toISOString(),
      },
      {
        id: "auto",
        direction: "inbound",
        human: false,
        body: "OOO",
        at: new Date(now + 2000).toISOString(),
      },
    );
    store.upsert(channel, t);
    expect(store.get(t.key, now + 3000)?.snoozedUntil).not.toBeNull();
  });
  it("wakes early on new human inbound and never drops saved edits", () => {
    const t = thread(channel);
    store.upsert(channel, t);
    store.saveDrafts(t.key, draft(), null);
    store.setState(t.key, "snooze", ["in-1"], now);
    t.messages.push({
      id: "in-2",
      direction: "inbound",
      human: true,
      body: "Another question",
      at: new Date(now + 1000).toISOString(),
    });
    store.upsert(channel, t);
    expect(store.get(t.key, now + 2000)?.snoozedUntil).toBeNull();
    expect(store.get(t.key)?.drafts?.edits.direct).toBe("Edited answer");
  });
  it("rejects stale snooze/archive and unsnoozes immediately", () => {
    const t = thread(channel);
    store.upsert(channel, t);
    expect(() => store.setState(t.key, "snooze", [], now)).toThrow("new reply");
    expect(() => store.setState(t.key, "archive", [], now)).toThrow("new reply");
    store.setState(t.key, "snooze", ["in-1"], now);
    store.setState(t.key, "unsnooze", ["in-1"], now + 1);
    expect(store.get(t.key, now + 1)?.snoozedUntil).toBeNull();
  });
  it("archive clears snooze and a newer inbound restores the thread", () => {
    const t = thread(channel);
    store.upsert(channel, t);
    store.setState(t.key, "snooze", ["in-1"], now);
    store.setState(t.key, "archive", ["in-1"], now + 1);
    expect(store.get(t.key, now + 2)).toMatchObject({
      snoozedUntil: null,
      archivedAt: new Date(now + 1).toISOString(),
    });
    expect(() => store.setState(t.key, "snooze", ["in-1"], now + 2)).toThrow("Restore");
    t.messages.push({ ...t.messages[0]!, id: "in-2", at: new Date(now + 5000).toISOString() });
    store.upsert(channel, t);
    expect(store.get(t.key)?.archivedAt).toBeNull();
  });
});
it("rejects stale draft saves and serializes generation claims across processes", () => {
  const t = thread();
  store.upsert("email", t);
  const saved = store.saveDrafts(t.key, draft(), null);
  expect(saved.revision).toBe(1);
  expect(() => store.saveDrafts(t.key, draft(), null)).toThrow("changed");
  const other = new ReplyReviewStore(path);
  const claim = store.claim("generate");
  expect(claim).toBeTruthy();
  expect(other.claim("generate")).toBeNull();
  store.release("generate", claim!);
  expect(other.claim("generate")).toBeTruthy();
  other.close();
});
it("keeps uncertain sends and prevents a second send or stale autosave", () => {
  const t = thread();
  store.upsert("email", t);
  store.saveDrafts(t.key, draft(), null);
  const send = store.beginSend(
    t.key,
    {
      id: "send-1",
      status: "pending",
      body: "Edited answer",
      generationId: "draft-1",
      variant: "direct",
    },
    1,
  );
  store.updateSend(t.key, { ...send, status: "uncertain" });
  expect(() => store.saveDrafts(t.key, draft(), 1)).toThrow("being sent");
  expect(() => store.beginSend(t.key, { ...send, id: "send-2" }, 1)).toThrow("pending");
  expect(store.get(t.key)?.drafts?.edits.direct).toBe("Edited answer");
  store.updateSend(t.key, { ...send, status: "sent", sentAt: new Date(now).toISOString() });
  expect(store.get(t.key)?.drafts?.edits.direct).toBe("");
  expect(() => store.saveDrafts(t.key, draft(), 1)).toThrow("changed");
  expect(store.beginSend(t.key, send, 1).status).toBe("sent");
});
