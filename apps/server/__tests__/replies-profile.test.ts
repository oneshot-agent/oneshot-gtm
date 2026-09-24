import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxResult, ReplyThread } from "@oneshot-gtm/shared-types";

const mocks = vi.hoisted(() => ({
  prospect: vi.fn(),
  stored: new Map<string, ReplyThread>(),
  inbox: { replies: [], conversations: [], hasMore: false } as InboxResult,
}));
vi.mock("@oneshot-gtm/core", () => ({
  classifyReply: () => "human",
  demoMode: () => false,
  demoFixture: () => null,
  currentWorkspaceName: () => "test",
  getLedger: () => ({ getProspectById: mocks.prospect, getProspectByEmail: mocks.prospect }),
  getLinkedInInboxStore: () => ({ threads: () => [], accounts: () => [] }),
  getReplyReviewStore: () => ({
    list: () => [...mocks.stored.values()].map((t) => structuredClone(t)),
    upsert: (_scope: string, t: ReplyThread) => mocks.stored.set(t.key, structuredClone(t)),
  }),
  loadConfig: () => ({}),
  linkedInMatches: () => [],
  replyContextVersion: () => "context",
}));
vi.mock("../src/api/inbox.ts", () => ({
  listInboxRoute: async () => Response.json(mocks.inbox),
}));
vi.mock("../src/linkedin-backfill.ts", () => ({ backfillStatus: () => null }));

const { collectReplies } = await import("../src/api/replies-view.ts");
const read = () => collectReplies(new Request("http://localhost/api/replies"));

beforeEach(() => {
  mocks.prospect.mockReset();
  mocks.inbox = { replies: [], conversations: [], hasMore: false };
  mocks.stored.clear();
  mocks.stored.set("saved", {
    key: "saved",
    channel: "email",
    name: "Ada",
    company: null,
    subject: "Question",
    address: "ada@example.test",
    workspace: "test",
    prospectId: 7,
    messages: [],
    lastActivityAt: "2026-09-24T12:00:00Z",
    archivedAt: null,
    snoozedUntil: null,
    needsReply: false,
    canSend: true,
    canGenerate: false,
    contextVersion: "context",
    drafts: null,
    send: null,
  });
});

describe("LinkedIn profile links in replies", () => {
  it("uses the current prospect profile even for email outside the live provider window", async () => {
    mocks.prospect.mockReturnValue({ id: 7, linkedin_url: "https://www.linkedin.com/in/ada" });
    expect((await read()).threads[0]?.profileUrl).toBe("https://www.linkedin.com/in/ada");
    mocks.prospect.mockReturnValue({
      id: 7,
      linkedin_url: "https://www.linkedin.com/in/ada-updated",
    });
    expect((await read()).threads[0]?.profileUrl).toBe("https://www.linkedin.com/in/ada-updated");
    mocks.prospect.mockReturnValue({ id: 7, linkedin_url: null });
    expect((await read()).threads[0]?.profileUrl).toBeNull();
  });

  it("includes the matched prospect profile on newly collected email", async () => {
    mocks.stored.clear();
    mocks.prospect.mockReturnValue({ id: 7, linkedin_url: "https://www.linkedin.com/in/ada" });
    mocks.inbox.replies.push({
      id: "incoming",
      fromEmail: "ada@example.test",
      fromRaw: "Ada",
      subject: "Hello",
      body: "Tell me more",
      receivedAt: "2026-09-24T12:00:00Z",
      kind: "human",
      intent: null,
      intentReason: null,
      sourceIdentityId: "gmail:test",
      sourceProvider: "gmail",
      threadId: "incoming",
      messageId: "message",
      matched: null,
      thread: null,
    });
    const result = await read();
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      prospectId: 7,
      profileUrl: "https://www.linkedin.com/in/ada",
    });
  });

  it("leaves unknown profiles absent", async () => {
    expect((await read()).threads[0]?.profileUrl).toBeNull();
  });

  it("does not resolve a prospect id against another workspace", async () => {
    mocks.stored.get("saved")!.workspace = "other";
    mocks.prospect.mockReturnValue({
      id: 7,
      linkedin_url: "https://www.linkedin.com/in/someone-else",
    });
    expect((await read()).threads[0]?.profileUrl).toBeNull();
    expect(mocks.prospect).not.toHaveBeenCalled();
  });
});
