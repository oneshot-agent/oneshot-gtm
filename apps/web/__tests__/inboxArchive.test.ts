import { describe, expect, it } from "vitest";
import { inboxConversations, inboxNeedsAttention } from "../src/lib/inboxArchive.ts";
describe("inbox archive visibility", () => {
  const active = { archivedAt: null, awaitingReply: true, status: null };
  const archived = { ...active, archivedAt: "2026-09-09T12:00:00Z" };
  it("separates inbox and archived conversations", () => {
    expect(inboxConversations([active, archived], false)).toEqual([active]);
    expect(inboxConversations([active, archived], true)).toEqual([archived]);
  });
  it("suppresses attention until a new reply clears the archive", () => {
    expect(inboxNeedsAttention(archived)).toBe(false);
    expect(inboxNeedsAttention({ ...archived, status: "needs_decision" })).toBe(false);
    expect(inboxNeedsAttention({ ...archived, archivedAt: null })).toBe(true);
  });
});
