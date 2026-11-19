import { afterEach, beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import type { LinkedInAccount } from "@oneshot-agent/sdk";
import type { LinkedInConversation, LinkedInMessage } from "../src/linkedin-fields.ts";
import {
  LinkedInInboxStore,
  LinkedInReplacementOwnerMismatchError,
} from "../src/linkedin-inbox.ts";
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
const label = (intent: "interested" | "meeting" | "question" | "unsubscribe") => ({
  intent,
  reason: null,
  confidence: 0.9,
  probabilities: null,
  classifier: "decisions:test",
  costMicros: 1,
  review: false,
});
const intentRows = (key: string) =>
  store.db.query("SELECT message_id FROM message_intents WHERE account_key=?").all(key);
beforeEach(() => {
  store = new LinkedInInboxStore(
    join(process.env.ONESHOT_GTM_HOME!, `replacement-${crypto.randomUUID()}.sqlite`),
  );
  store.saveAccount({
    key: "wallet:old",
    wallet: "wallet",
    workspace: "alpha",
    account: account("old"),
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveConversation("wallet:old", conversation("old-chat"), [], "old");
  store.assign("linkedin:wallet:old:old-chat", { workspace: "beta", prospectId: 7 });
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
    owner: { workspace: "beta", prospectId: 7, manual: true },
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
    workspace: "alpha",
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
  expect(store.threads()[0]?.owner).toMatchObject({ manual: true, workspace: "beta" });
});
it("moves the replacement's labels onto the messages they are kept under", () => {
  store.saveMessages("wallet:old", [
    { ...message("old-second", "old-chat"), provider_message_id: "second" },
  ]);
  store.saveAccount({
    key: "wallet:new",
    wallet: "wallet",
    workspace: "alpha",
    account: account("new"),
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveConversation("wallet:new", conversation("new-chat"), [], "new");
  store.saveMessages("wallet:new", [
    message("new-message", "new-chat"),
    { ...message("new-second", "new-chat"), provider_message_id: "second" },
    { ...message("new-only", "new-chat"), provider_message_id: "only" },
  ]);
  // The kept copy holds only a claim, or already has a label of its own.
  store.claimMessageIntent("wallet:old", "old-message");
  store.setMessageIntent("wallet:old", "old-second", label("meeting"));
  store.setMessageIntent("wallet:new", "new-message", label("interested"));
  store.setMessageIntent("wallet:new", "new-second", label("question"));
  store.setMessageIntent("wallet:new", "new-only", label("question"));
  store.replaceAccount("wallet:old", account("new"), []);
  expect(store.messageIntent("wallet:old", "old-message")?.intent).toBe("interested");
  expect(store.messageIntent("wallet:old", "old-second")?.intent).toBe("meeting");
  expect(store.messageIntent("wallet:old", "new-only")?.intent).toBe("question");
  expect(intentRows("wallet:new")).toEqual([]);
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
    owner: { workspace: "beta", prospectId: 7, manual: true },
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

it("a reconciled duplicate's label replaces failure state on the message it merges into", () => {
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
  // The kept message failed every retry; its duplicate was labelled meanwhile.
  for (let i = 0; i < 3; i++) store.recordMessageIntentFailure("wallet:old", "old-message");
  store.setMessageIntent("wallet:old", "new-message", label("interested"));
  store.reconcileReplacementHistory("wallet:old");
  expect(store.messageIntent("wallet:old", "old-message")?.intent).toBe("interested");
  expect(intentRows("wallet:old")).toEqual([{ message_id: "old-message" }]);
});

it("a reconciled duplicate's unsubscribe replaces the kept message's other label", () => {
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
  store.setMessageIntent("wallet:old", "old-message", label("question"));
  store.db.query("INSERT INTO label_copies VALUES('wallet:old','old-message','beta',7)").run();
  store.setMessageIntent("wallet:old", "new-message", label("unsubscribe"));
  store.reconcileReplacementHistory("wallet:old");
  expect(store.messageIntent("wallet:old", "old-message")?.intent).toBe("unsubscribe");
  // Copied to the kept message's deliveries again.
  expect(store.db.query("SELECT count(*) AS n FROM label_copies").get()).toEqual({ n: 0 });
});

it("a replacement carries deliveries and their ledger targets to the kept message", () => {
  store.saveAccount({
    key: "wallet:new",
    wallet: "wallet",
    workspace: "alpha",
    account: account("new"),
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveConversation("wallet:new", conversation("new-chat"), [], "new");
  store.saveMessages("wallet:new", [message("new-message", "new-chat")]);
  store.setMessageIntent("wallet:new", "new-message", label("unsubscribe"));
  store.db.query("INSERT INTO deliveries VALUES('wallet:new','new-message','beta',7)").run();
  store.db
    .query(
      "INSERT INTO delivery_targets VALUES('wallet:new','new-message','beta',7,'ext:wallet:new:new-message')",
    )
    .run();
  store.replaceAccount("wallet:old", account("new"), []);
  expect(store.db.query("SELECT * FROM deliveries").all()).toEqual([
    { account_key: "wallet:old", message_id: "old-message", workspace: "beta", prospect_id: 7 },
  ]);
  // The target keeps the event id the workspace ledger holds.
  expect(store.db.query("SELECT message_id, event_key FROM delivery_targets").all()).toEqual([
    { message_id: "old-message", event_key: "ext:wallet:new:new-message" },
  ]);
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

/** The account being replaced, as Mia connected it, and a record of the new connection saved for `owner`. */
function replacingMiasAccountWith(owner: string | undefined) {
  store.db.exec("DELETE FROM accounts WHERE key='wallet:old'");
  store.saveAccount({
    key: "wallet:old",
    wallet: "wallet",
    workspace: "alpha",
    account: account("old"),
    sync: null,
    checkedAt: null,
    error: null,
    ownerMember: "mia@example.com",
  });
  store.saveAccount({
    key: "wallet:new",
    wallet: "wallet",
    workspace: "alpha",
    account: account("new"),
    sync: null,
    checkedAt: null,
    error: null,
    ownerMember: owner,
  });
  store.saveConversation("wallet:new", conversation("new-chat"), [], "new");
  store.saveMessages("wallet:new", [message("new-message", "new-chat")]);
}
const untouched = () => {
  expect(store.account("wallet:old")).toMatchObject({
    ownerMember: "mia@example.com",
    account: { id: "old" },
  });
  expect(store.account("wallet:old")?.previousAccountIds).toBeUndefined();
  expect(store.threads("wallet:old")).toHaveLength(1);
  expect(store.threads("wallet:new")).toHaveLength(1);
  expect(store.allMessages("wallet:new")).toHaveLength(1);
};
it.each([
  ["another member", "bob@example.com"],
  ["no member", undefined],
])("merges no conversation from a record saved for %s into a member's account", (_who, owner) => {
  replacingMiasAccountWith(owner);
  expect(() => store.replaceAccount("wallet:old", account("new"), [])).toThrow(
    LinkedInReplacementOwnerMismatchError,
  );
  untouched();
  expect(store.account("wallet:new")?.ownerMember ?? undefined).toBe(owner);
});
it("merges no conversation saved under a key with no account record", () => {
  replacingMiasAccountWith("mia@example.com");
  store.db.exec("DELETE FROM accounts WHERE key='wallet:new'");
  expect(() => store.replaceAccount("wallet:old", account("new"), [])).toThrow(
    LinkedInReplacementOwnerMismatchError,
  );
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.threads("wallet:new")).toHaveLength(1);
  expect(store.allMessages("wallet:new")).toHaveLength(1);
});
it("merges a record saved for the same member", () => {
  replacingMiasAccountWith("mia@example.com");
  store.replaceAccount("wallet:old", account("new"), []);
  expect(store.account("wallet:old")).toMatchObject({
    ownerMember: "mia@example.com",
    account: { id: "new" },
  });
  expect(store.account("wallet:new")).toBeNull();
  expect(store.threads("wallet:new")).toHaveLength(0);
  expect(store.allMessages("wallet:old")).toHaveLength(1);
});
