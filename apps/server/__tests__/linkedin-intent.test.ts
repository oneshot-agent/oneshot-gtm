import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { join } from "node:path";

// The store routes a delivery to its workspace by name: this test's home is
// the active workspace, named "test", which owns the account "mine".
process.env["ONESHOT_GTM_WORKSPACE"] = "test";

const {
  Ledger,
  canonicalLinkedInProfileKey,
  configDir,
  getLinkedInInboxStore,
  isProspectOptedOut,
} = await import("@oneshot-gtm/core");
const { labelLinkedInReplies } = await import("../src/linkedin-intent.ts");
const { linkedInThreads } = await import("../src/api/replies-view.ts");

const home = configDir();
const store = getLinkedInInboxStore();
const ledger = new Ledger(join(home, "ledger.sqlite"));
afterAll(() => ledger.close());

const url = "https://linkedin.com/in/ada-intent";
const prospectId = ledger.upsertProspect({
  email: "ada-intent@example.test",
  name: "Ada",
  linkedin_url: url,
});

function label(intent: "interested" | "unsubscribe" | "question") {
  return {
    intent,
    reason: intent,
    confidence: 0.9,
    probabilities: null,
    classifier: "decisions:stub",
    costMicros: 5,
    review: false,
    fellBack: false,
  };
}

function message(id: string, text: string, sentAt: string, account = "mine") {
  return {
    id,
    conversation_id: `chat-${account}`,
    direction: "inbound",
    sender_name: "Ada",
    text,
    sent_at: sentAt,
    deleted: false,
    attachments: [],
  };
}

beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts; DELETE FROM conversations; DELETE FROM messages; DELETE FROM identities; DELETE FROM deliveries; DELETE FROM message_intents;",
  );
  for (const [key, workspace] of [
    ["mine", "test"],
    ["theirs", "other"],
  ] as const)
    store.saveAccount({
      key,
      wallet: "wallet",
      workspace,
      account: { id: key, status: "connected", allowed_actions: ["read", "reply"] } as never,
      sync: null,
      checkedAt: null,
      error: null,
    });
  store.saveConversation(
    "mine",
    {
      id: "chat-mine",
      attendees: [{ is_self: false, provider_id: "ada", profile_url: url }],
      attendees_synced: true,
      type: 0,
    } as never,
    [],
  );
  store.assign("linkedin:mine:chat-mine", { workspace: "test", prospectId });
});

it("labels only this workspace's accounts, within the limit", async () => {
  store.saveMessages("mine", [
    message("a", "Tell me more", "2026-11-03T10:00:00Z"),
    message("b", "What does it cost?", "2026-11-02T10:00:00Z"),
    message("c", "Sounds good", "2026-11-01T10:00:00Z"),
  ] as never);
  store.saveMessages("theirs", [message("x", "Hello", "2026-11-04T10:00:00Z", "theirs")] as never);
  const classify = vi.fn(async () => label("interested"));

  expect(await labelLinkedInReplies({ classify, limit: 2 })).toMatchObject({
    checked: 2,
    labelled: 2,
  });
  expect(classify).toHaveBeenCalledTimes(2);
  expect(store.messageIntent("mine", "a")?.intent).toBe("interested");
  expect(store.messageIntent("mine", "c")).toBeNull();

  await labelLinkedInReplies({ classify });
  expect(classify).toHaveBeenCalledTimes(3);
  expect(store.messageIntent("theirs", "x")).toBeNull();
});

it("never throws out of a failing pass", async () => {
  store.saveMessages("mine", [message("a", "Tell me more", "2026-11-03T10:00:00Z")] as never);
  const out = await labelLinkedInReplies({
    classify: async () => {
      throw new Error("model down");
    },
  });
  expect(out).toMatchObject({ checked: 1, failed: 1, labelled: 0 });
});

it("an unsubscribe opts the prospect out and stops their live cadences", async () => {
  store.saveMessages("mine", [
    message("stop", "Please take me off your list", "2026-11-03T10:00:00Z"),
  ] as never);
  const matches = [
    {
      workspace: "test",
      home,
      prospectId,
      name: "Ada",
      profile: canonicalLinkedInProfileKey(url)!,
    },
  ];
  store.deliverAll(store.threads(), matches);
  // Enrolled after the reply was delivered: the label is what stops it.
  ledger.enrollCadence({ prospectId, playName: "intro", nextDueAt: "2026-12-01T09:00:00.000Z" });
  expect(ledger.getCadence(prospectId, "intro")?.status).toBe("active");

  const out = await labelLinkedInReplies({ classify: async () => label("unsubscribe") });
  expect(out).toMatchObject({ labelled: 1, cadencesStopped: 1 });
  expect(ledger.getCadence(prospectId, "intro")?.status).toBe("unsubscribed");
  const db = (ledger as unknown as { db: Database }).db;
  expect(isProspectOptedOut(db, prospectId)).toBe(true);
});

it("a thread shows the label of its latest labelled human reply", async () => {
  store.saveMessages("mine", [
    message("first", "What does it cost?", "2026-11-01T10:00:00Z"),
    message("second", "Sounds good, let's talk", "2026-11-02T10:00:00Z"),
    message("ooo", "I am currently out of the office until Monday.", "2026-11-03T10:00:00Z"),
  ] as never);
  const thread = () => linkedInThreads().find((t) => t.accountKey === "mine");
  expect(thread()).toMatchObject({ intent: null, intentReview: false });

  store.setMessageIntent("mine", "first", label("question"));
  expect(thread()).toMatchObject({ intent: "question" });
  store.setMessageIntent("mine", "second", { ...label("interested"), review: true });
  expect(thread()).toMatchObject({ intent: "interested", intentReview: true });
});
