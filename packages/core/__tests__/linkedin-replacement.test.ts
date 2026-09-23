import { afterEach, beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import type { LinkedInAccount, LinkedInConversation, LinkedInMessage } from "@oneshot-agent/sdk";
import { LinkedInInboxStore } from "../src/linkedin-inbox.ts";
let store: LinkedInInboxStore;
const account = (id: string, member = "owner") =>
  ({
    id,
    member_urn: member,
    status: "connected",
    allowed_actions: ["read", "reply", "view_profile"],
  }) as LinkedInAccount;
const conversation = (id: string) =>
  ({
    id,
    provider_chat_id: "stable-chat",
    attendees: [],
    attendees_synced: false,
    name: "Ada",
    read_only: 0,
    updated_at: "2026-01-01",
  }) as unknown as LinkedInConversation;
const message = (id: string, conversationId: string) =>
  ({
    id,
    conversation_id: conversationId,
    provider_message_id: "stable-message",
    sender_provider_id: "person",
    sender_name: "Ada",
    direction: "inbound",
    text: "Hello",
    sent_at: "2020-01-01",
    attachments: [],
  }) as unknown as LinkedInMessage;
beforeEach(() => {
  store = new LinkedInInboxStore(
    join(process.env.ONESHOT_GTM_HOME!, `replacement-${crypto.randomUUID()}.sqlite`),
  );
  store.saveAccount({
    key: "wallet:old",
    wallet: "wallet",
    workspace: "gtm",
    account: account("old"),
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveConversation("wallet:old", conversation("old-chat"), [], "old");
  store.assign("linkedin:wallet:old:old-chat", { workspace: "sdk", prospectId: 7 });
  store.saveMessages("wallet:old", [message("old-message", "old-chat")]);
  store.saveIdentity("wallet:old", {
    providerId: "person",
    profile: "linkedin.com/in/ada",
    name: "Ada",
    resolvedAt: "2026-01-01",
  });
  store.saveProgress("backfill:wallet:old", {
    stage: "blocked",
    resumeStage: "resolve",
    failures: [{ message: "permission" }],
  });
});
afterEach(() => store.close());
it("keeps local history, identity cache, and manual ownership across a verified account replacement", () => {
  store.replaceAccount("wallet:old", account("new"), []);
  expect(store.account("wallet:old")).toMatchObject({
    account: { id: "new" },
    previousAccountIds: ["old"],
  });
  expect(store.threads()[0]).toMatchObject({
    key: "linkedin:wallet:old:old-chat",
    owner: { workspace: "sdk", prospectId: 7, manual: true },
    sourceAccountId: "old",
  });
  expect(store.allMessages("wallet:old")).toHaveLength(1);
  expect(store.identity("wallet:old", "person")?.profile).toBe("linkedin.com/in/ada");
  expect(store.progress("backfill:wallet:old")).toMatchObject({
    stage: "capture",
    failures: [{ message: "permission" }],
  });
});
it("merges reimported provider IDs without duplicating messages or changing review thread keys", () => {
  store.replaceAccount("wallet:old", account("new"), []);
  store.saveConversation("wallet:old", conversation("new-chat"), [], "new");
  store.saveMessages("wallet:old", [
    { ...message("new-message", "new-chat"), edited: true, text: "Edited" },
  ]);
  expect(store.threads()).toHaveLength(1);
  expect(store.threads()[0]).toMatchObject({
    key: "linkedin:wallet:old:old-chat",
    conversation: { id: "new-chat" },
    owner: { manual: true },
    sourceAccountId: "new",
  });
  expect(store.allMessages("wallet:old")).toEqual([
    expect.objectContaining({
      id: "old-message",
      conversation_id: "new-chat",
      edited: true,
      text: "Edited",
    }),
  ]);
  expect(store.messages("wallet:old", "old-chat")).toHaveLength(0);
});
it("merges a replacement already captured by the other server", () => {
  store.saveAccount({
    key: "wallet:new",
    wallet: "wallet",
    workspace: "gtm",
    account: account("new"),
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveConversation("wallet:new", conversation("new-chat"), [], "new");
  store.saveMessages("wallet:new", [message("new-message", "new-chat")]);
  store.replaceAccount("wallet:old", account("new"), []);
  expect(store.accounts()).toHaveLength(1);
  expect(store.threads()).toHaveLength(1);
  expect(store.allMessages("wallet:old")).toHaveLength(1);
  expect(store.threads()[0]?.owner).toMatchObject({ manual: true, workspace: "sdk" });
});
it("refuses to attach another person's login to the saved history", () => {
  expect(() => store.replaceAccount("wallet:old", account("new", "someone-else"), [])).toThrow(
    "does not match",
  );
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.allMessages("wallet:old")).toHaveLength(1);
});
it("is idempotent when the completed connection intent is polled repeatedly", () => {
  store.replaceAccount("wallet:old", account("new"), []);
  store.saveProgress("wallet:old:messages", { cursor: "in-progress" });
  store.replaceAccount("wallet:old", account("new"), []);
  expect(store.progress("wallet:old:messages")).toEqual({ cursor: "in-progress" });
  expect(store.account("wallet:old")?.previousAccountIds).toEqual(["old"]);
});
it("does not let a stale local replay restore pre-replacement conversation IDs", () => {
  store.replaceAccount("wallet:old", account("new"), []);
  store.saveConversation("wallet:old", conversation("new-chat"), [], "new");
  store.saveConversation("wallet:old", conversation("old-chat"), []);
  expect(store.threads()[0]?.conversation.id).toBe("new-chat");
  expect(store.messages("wallet:old", "new-chat")).toHaveLength(1);
});

it("reconciles regenerated provider chat/message IDs by unique exact cross-connection evidence", () => {
  store.replaceAccount("wallet:old", account("new"), []);
  store.saveConversation(
    "wallet:old",
    { ...conversation("new-chat"), provider_chat_id: "regenerated-chat" },
    [],
    "new",
  );
  store.saveMessages(
    "wallet:old",
    [{ ...message("new-message", "new-chat"), provider_message_id: "regenerated-message" }],
    "new",
  );
  store.reconcileReplacementHistory("wallet:old");
  expect(store.threads()).toHaveLength(1);
  expect(store.threads()[0]).toMatchObject({
    key: "linkedin:wallet:old:old-chat",
    owner: { workspace: "sdk", prospectId: 7, manual: true },
    conversation: { id: "new-chat" },
  });
  expect(store.allMessages("wallet:old")).toEqual([
    expect.objectContaining({
      id: "old-message",
      provider_message_id: "regenerated-message",
      conversation_id: "new-chat",
    }),
  ]);
  expect(store.threadForConversation("wallet:old", "old-chat")?.key).toBe(
    "linkedin:wallet:old:old-chat",
  );
  store.saveConversation("wallet:old", conversation("old-chat"), []);
  expect(store.threads()[0]?.conversation.id).toBe("new-chat");
  store.saveMessages(
    "wallet:old",
    [{ ...message("new-message", "new-chat"), provider_message_id: "regenerated-message" }],
    "new",
  );
  store.reconcileReplacementHistory("wallet:old");
  expect(store.allMessages("wallet:old")).toHaveLength(1);
});

it("does not collapse distinct identical messages from the same connection", () => {
  store.saveMessages(
    "wallet:old",
    [{ ...message("another-message", "old-chat"), provider_message_id: "another-provider" }],
    "old",
  );
  store.replaceAccount("wallet:old", account("new"), []);
  store.saveConversation(
    "wallet:old",
    { ...conversation("new-chat"), provider_chat_id: "regenerated-chat" },
    [],
    "new",
  );
  store.saveMessages(
    "wallet:old",
    [{ ...message("new-message", "new-chat"), provider_message_id: "regenerated-message" }],
    "new",
  );
  store.reconcileReplacementHistory("wallet:old");
  expect(store.allMessages("wallet:old")).toHaveLength(3);
  expect(store.threads()).toHaveLength(2);
});

it("does not merge history using names or changed message content", () => {
  store.replaceAccount("wallet:old", account("new"), []);
  store.saveConversation(
    "wallet:old",
    { ...conversation("new-chat"), provider_chat_id: "regenerated-chat" },
    [],
    "new",
  );
  store.saveMessages(
    "wallet:old",
    [
      {
        ...message("new-message", "new-chat"),
        provider_message_id: "regenerated-message",
        text: "Different",
      },
    ],
    "new",
  );
  store.reconcileReplacementHistory("wallet:old");
  expect(store.allMessages("wallet:old")).toHaveLength(2);
  expect(store.threads()).toHaveLength(2);
});
