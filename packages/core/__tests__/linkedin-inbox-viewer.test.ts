import { afterEach, beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import type { LinkedInConversation, LinkedInMessage } from "../src/linkedin-fields.ts";
import {
  LinkedInInboxStore,
  type LinkedInAccountRecord,
  type LinkedInViewer,
} from "../src/linkedin-inbox.ts";

// A LinkedIn account is one person's identity (#1040). The store filters by
// the member who connected it whenever a lookup is given a viewer, and
// returns everything when it is given none (the background jobs).

const ANA: LinkedInViewer = { email: "ana@example.com", installOwner: true };
const BEN: LinkedInViewer = { email: "ben@example.com", installOwner: false };
const account = (key: string, ownerMember?: string): LinkedInAccountRecord => ({
  key,
  wallet: "wallet",
  workspace: "default",
  account: { id: key, status: "connected", allowed_actions: ["read", "reply"] } as never,
  sync: null,
  checkedAt: null,
  error: null,
  ...(ownerMember ? { ownerMember } : {}),
});
const message = (id: string, conversationId: string): LinkedInMessage =>
  ({
    id,
    conversation_id: conversationId,
    direction: "inbound",
    sender_name: "Prospect",
    text: `Message ${id}`,
    sent_at: "2026-11-01T00:00:00Z",
    deleted: false,
  }) as LinkedInMessage;
const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key).toSorted();

let store: LinkedInInboxStore;
beforeEach(() => {
  store = new LinkedInInboxStore(
    join(process.env.ONESHOT_GTM_HOME!, `viewer-${crypto.randomUUID()}.sqlite`),
  );
  // ana's, ben's, and one connected before members existed.
  store.saveAccount(account("ana-account", "ana@example.com"));
  store.saveAccount(account("ben-account", "ben@example.com"));
  store.saveAccount(account("old-account"));
  for (const key of ["ana-account", "ben-account", "old-account"]) {
    const chat = `${key}-chat`;
    store.saveConversation(key, { id: chat, attendees: [] } as unknown as LinkedInConversation, []);
    store.saveMessages(key, [message(`${key}-message`, chat)]);
  }
});
afterEach(() => store.close());

it("returns every account, thread and message when no viewer is given", () => {
  expect(keys(store.accounts())).toEqual(["ana-account", "ben-account", "old-account"]);
  expect(store.threads()).toHaveLength(3);
  expect(store.thread("linkedin:ben-account:ben-account-chat")).not.toBeNull();
  expect(store.messages("ben-account", "ben-account-chat")).toHaveLength(1);
  expect(store.allMessages("ben-account")).toHaveLength(1);
});

it("gives a member only the accounts they connected, with their threads and messages", () => {
  expect(keys(store.accounts(BEN))).toEqual(["ben-account"]);
  expect(store.account("ana-account", BEN)).toBeNull();
  expect(store.threads(undefined, BEN).map((t) => t.accountKey)).toEqual(["ben-account"]);
  expect(store.threads("ana-account", BEN)).toEqual([]);
  expect(store.thread("linkedin:ana-account:ana-account-chat", BEN)).toBeNull();
  expect(store.thread("linkedin:ben-account:ben-account-chat", BEN)).not.toBeNull();
  expect(store.messages("ana-account", "ana-account-chat", BEN)).toEqual([]);
  expect(store.allMessages("ana-account", BEN)).toEqual([]);
  expect(store.messages("ben-account", "ben-account-chat", BEN)).toHaveLength(1);
  expect(store.threadForConversation("ana-account", "ana-account-chat", BEN)).toBeNull();
  expect(store.threadForConversation("ben-account", "ben-account-chat", BEN)?.key).toBe(
    "linkedin:ben-account:ben-account-chat",
  );
  expect(store.threadForConversation("ana-account", "ana-account-chat")).not.toBeNull();
  expect(store.visibleTo("ana-account", BEN)).toBe(false);
  expect(store.visibleTo("ben-account", BEN)).toBe(true);
});

it("assigns an account with no recorded member to the install's owner", () => {
  expect(keys(store.accounts(ANA))).toEqual(["ana-account", "old-account"]);
  expect(store.messages("old-account", "old-account-chat", ANA)).toHaveLength(1);
  expect(store.visibleTo("old-account", BEN)).toBe(false);
  // The local owner of an install that lists no owner has no email.
  const local: LinkedInViewer = { email: null, installOwner: true };
  expect(keys(store.accounts(local))).toEqual(["old-account"]);
  // A request that is nobody's reads nothing.
  expect(store.accounts({ email: null, installOwner: false })).toEqual([]);
});

it("shows everything to the one person using an install with no members", () => {
  const only: LinkedInViewer = { email: null, installOwner: true, onlyUser: true };
  expect(store.accounts(only)).toHaveLength(3);
  expect(store.threads(undefined, only)).toHaveLength(3);
  expect(store.messages("ben-account", "ben-account-chat", only)).toHaveLength(1);
});

it("keeps the member who connected an account through later saves", () => {
  // A sync or a status update saves the record without naming the owner, or names another.
  const { ownerMember: _dropped, ...withoutOwner } = store.account("ben-account")!;
  store.saveAccount({ ...withoutOwner, error: "provider unavailable" });
  expect(store.account("ben-account")?.ownerMember).toBe("ben@example.com");
  store.saveAccount({ ...store.account("ben-account")!, ownerMember: "ana@example.com" });
  expect(store.account("ben-account")?.ownerMember).toBe("ben@example.com");
});

it("leaves an account saved with no member with the install's owner when a member saves it later", () => {
  // ben signs in to the account that was connected before members existed.
  store.saveAccount({ ...store.account("old-account")!, ownerMember: "ben@example.com" });
  expect(store.account("old-account")?.ownerMember).toBeUndefined();
  expect(store.visibleTo("old-account", BEN)).toBe(false);
  expect(store.visibleTo("old-account", ANA)).toBe(true);
  expect(store.messages("old-account", "old-account-chat", BEN)).toEqual([]);
});
