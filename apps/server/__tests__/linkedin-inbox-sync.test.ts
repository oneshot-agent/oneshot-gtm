import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: (...args: unknown[]) => sdk(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  oneshotEnvReady: () => true,
  linkedInMatches: () => [],
}));
const { getLinkedInInboxStore, getReplyReviewStore } = await import("@oneshot-gtm/core");
const { refreshLinkedInInbox } = await import("../src/linkedin-sync.ts");
const store = getLinkedInInboxStore();
const conversation = {
  id: "chat",
  provider_chat_id: "provider-chat",
  name: "Ada",
  subject: null,
  type: 0,
  attendees: [{ is_self: false, profile_url: "https://linkedin.com/in/ada", name: "Ada" }],
  unread_count: 1,
  archived: false,
  read_only: 0,
  muted_until: null,
  last_message_at: "2026-09-17T12:00:00Z",
  attendees_synced: true,
  updated_at: "2026-09-17T12:00:00Z",
};
const message = (id: string) => ({
  id,
  conversation_id: "chat",
  provider_message_id: `provider-${id}`,
  direction: "inbound",
  sender_provider_id: "ada",
  sender_name: "Ada",
  text: "Hello",
  sent_at: "2026-09-17T12:00:00Z",
  seen: false,
  edited: false,
  deleted: false,
  attachments: [],
  source: "webhook",
  ingested_at: "2026-09-17T12:00:00Z",
  updated_at: "2026-09-17T12:00:00Z",
});
beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts;DELETE FROM conversations;DELETE FROM messages;DELETE FROM progress;",
  );
  getReplyReviewStore().db.exec("DELETE FROM review_leases");
  sdk.mockReset();
});

it("resumes an interrupted message window without skipping pages or buying a sync", async () => {
  let fail = true;
  sdk.mockImplementation(async (_workspace, op) => {
    if (op.kind === "accounts")
      return {
        wallet: "wallet",
        accounts: [{ id: "account", status: "connected", allowed_actions: ["read", "reply"] }],
      };
    if (op.kind === "status") return { sync_state: "partial", coverage: { complete: false } };
    if (op.kind === "conversations")
      return {
        conversations: op.options.archived ? [] : [conversation],
        has_more: false,
        next_cursor: null,
      };
    if (op.kind === "messages") {
      if (!op.options.cursor)
        return { messages: [message("one")], has_more: true, next_cursor: "page-two" };
      if (fail) throw new Error("Provider unavailable on page two");
      return { messages: [message("two")], has_more: false, next_cursor: null };
    }
    throw new Error(`Unexpected operation ${op.kind}`);
  });
  await refreshLinkedInInbox(true);
  expect(store.messages("wallet:account", "chat")).toHaveLength(1);
  expect(store.progress("wallet:account:messages")).toMatchObject({
    cursor: "page-two",
    complete: false,
  });
  expect(store.account("wallet:account")?.checkedAt).toBeNull();
  expect(store.account("wallet:account")?.error).toContain("page two");
  const before = sdk.mock.calls.length;
  fail = false;
  await refreshLinkedInInbox(true);
  expect(store.messages("wallet:account", "chat")).toHaveLength(2);
  expect(store.progress("wallet:account:messages")).toMatchObject({ complete: true });
  const resumed = sdk.mock.calls.slice(before).find(([, op]) => op.kind === "messages");
  expect(resumed?.[1].options.cursor).toBe("page-two");
  expect(sdk.mock.calls.every(([, op]) => op.kind !== "sync")).toBe(true);
});

it("upserts edited/deleted messages and preserves a manual assignment", async () => {
  store.saveConversation("wallet:account", conversation as never, []);
  const key = "linkedin:wallet:account:chat";
  store.assign(key, { workspace: "chosen", prospectId: 7 });
  store.saveConversation("wallet:account", { ...conversation, name: "Updated" } as never, []);
  store.saveMessages("wallet:account", [message("one")] as never);
  store.saveMessages("wallet:account", [
    { ...message("one"), text: "Edited", edited: true, deleted: true },
  ] as never);
  expect(store.messages("wallet:account", "chat")).toHaveLength(1);
  expect(store.messages("wallet:account", "chat")[0]).toMatchObject({
    text: "Edited",
    deleted: true,
  });
  expect(store.thread(key)?.owner).toEqual({ workspace: "chosen", prospectId: 7, manual: true });
});
