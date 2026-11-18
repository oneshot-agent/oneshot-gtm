import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../src/config.ts";
import { isProspectOptedOut } from "../src/contact-optout.ts";
import { Ledger } from "../src/ledger.ts";
import { canonicalLinkedInProfileKey } from "../src/ledger-prospects.ts";
import {
  LinkedInInboxStore,
  labelLinkedInReplyBatch,
  type LinkedInReplyLabel,
} from "../src/linkedin-inbox.ts";
import { currentWorkspaceName } from "../src/shared-db.ts";

// The workspace the store resolves a delivery's home by: this test's own
// home is the active workspace, so no registry is needed.
const home = configDir();
const workspace = currentWorkspaceName();
let ledger: Ledger;
let store: LinkedInInboxStore;

beforeEach(() => {
  ledger = new Ledger(join(home, "ledger.sqlite"));
  store = new LinkedInInboxStore(join(home, `inbox-${randomUUID()}.sqlite`));
});
afterEach(() => {
  store.close();
  ledger.close();
});

function raw(l: Ledger): Database {
  return (l as unknown as { db: Database }).db;
}

function label(intent: LinkedInReplyLabel["intent"], extra: Partial<LinkedInReplyLabel> = {}) {
  return {
    intent,
    reason: "because",
    confidence: 0.9,
    probabilities: { [intent]: 0.9 },
    classifier: "decisions:test",
    costMicros: 12,
    review: false,
    ...extra,
  } satisfies LinkedInReplyLabel;
}

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: "chat",
    direction: "inbound",
    sender_name: "Ada",
    text: "Can you tell me more about pricing?",
    sent_at: "2026-11-01T10:00:00Z",
    deleted: false,
    attachments: [],
    ...extra,
  };
}

/** One prospect with a delivered-to-be 1:1 thread on account `account`. */
function seedThread(messages: Array<ReturnType<typeof message>>) {
  const slug = `ada-${randomUUID().slice(0, 8)}`;
  const url = `https://linkedin.com/in/${slug}`;
  const prospectId = ledger.upsertProspect({
    email: `${slug}@example.test`,
    name: "Ada",
    linkedin_url: url,
  });
  const chat = `chat-${slug}`;
  store.saveConversation(
    "account",
    {
      id: chat,
      attendees: [{ is_self: false, profile_url: url }],
    } as never,
    [],
  );
  store.assign(`linkedin:account:${chat}`, { workspace, prospectId });
  store.saveMessages("account", messages.map((m) => ({ ...m, conversation_id: chat })) as never);
  const matches = [
    { workspace, home, prospectId, name: "Ada", profile: canonicalLinkedInProfileKey(url)! },
  ];
  return { prospectId, deliver: () => store.deliverAll(store.threads(), matches) };
}

function eventIntent(messageId: string) {
  return raw(ledger)
    .query(
      "SELECT intent, intent_review FROM channel_events WHERE source='oneshot-linkedin' AND external_event_id=?",
    )
    .get(`account:${messageId}`) as { intent: string | null; intent_review: number | null } | null;
}

describe("message labels in the shared store", () => {
  it("lists only unlabelled human inbound messages, newest first, and round-trips a label", () => {
    store.saveMessages("account", [
      message("old", { sent_at: "2026-10-01T10:00:00Z" }),
      message("new", { sent_at: "2026-11-02T10:00:00Z" }),
      message("mine", { direction: "outbound" }),
      message("gone", { deleted: true }),
      message("ooo", { text: "I am currently out of the office until Monday." }),
    ] as never);
    store.saveMessages("other", [message("elsewhere")] as never);

    const ids = () => store.unlabelledReplies(["account"], { limit: 10 }).map((r) => r.message.id);
    expect(ids()).toEqual(["new", "old"]);
    expect(store.unlabelledReplies(["account"], { limit: 1 }).map((r) => r.message.id)).toEqual([
      "new",
    ]);
    expect(store.unlabelledReplies([], { limit: 10 })).toEqual([]);

    expect(store.claimMessageIntent("account", "new")).toBe(true);
    expect(store.claimMessageIntent("account", "new")).toBe(false);
    expect(ids()).toEqual(["old"]);

    store.setMessageIntent("account", "new", label("interested", { review: true }));
    expect(store.messageIntent("account", "new")).toMatchObject({
      intent: "interested",
      reason: "because",
      confidence: 0.9,
      probabilities: { interested: 0.9 },
      classifier: "decisions:test",
      costMicros: 12,
      review: true,
    });
    // Labelled: never listed or claimed again.
    expect(ids()).toEqual(["old"]);
    expect(store.claimMessageIntent("account", "new")).toBe(false);
    expect(store.messageIntent("account", "old")).toBeNull();
    expect([...store.conversationIntents("account", "chat").keys()]).toEqual(["new"]);
  });

  it("backs a failed message off, and gives up after three failures", () => {
    store.saveMessages("account", [message("flaky")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    const listed = (at: number) =>
      store.unlabelledReplies(["account"], { limit: 10, now: at }).length;
    expect(store.claimMessageIntent("account", "flaky", now)).toBe(true);
    store.recordMessageIntentFailure("account", "flaky", now);
    expect(listed(now)).toBe(0);
    expect(store.claimMessageIntent("account", "flaky", now)).toBe(false);
    // One failure waits an hour; the next waits two.
    expect(listed(now + 61 * 60_000)).toBe(1);
    store.recordMessageIntentFailure("account", "flaky", now);
    expect(listed(now + 61 * 60_000)).toBe(0);
    expect(listed(now + 121 * 60_000)).toBe(1);
    store.recordMessageIntentFailure("account", "flaky", now);
    expect(listed(now + 24 * 60 * 60_000)).toBe(0);
    expect(store.claimMessageIntent("account", "flaky", now + 24 * 60 * 60_000)).toBe(false);
  });
});

describe("labels reach the workspace ledger", () => {
  it("records a label stored before delivery, and fills a row written without one", () => {
    const { deliver } = seedThread([message("early"), message("late")]);
    store.setMessageIntent("account", "early", label("question", { review: true }));
    deliver();
    expect(eventIntent("early")).toEqual({ intent: "question", intent_review: 1 });
    expect(eventIntent("late")).toEqual({ intent: null, intent_review: null });

    // Stored with no deliveries copied (a crash between the two): the next
    // sync's replay fills the row in, and never replaces a label it has.
    raw(ledger)
      .query("UPDATE channel_events SET intent=NULL WHERE external_event_id='account:early'")
      .run();
    deliver();
    expect(eventIntent("early")).toEqual({ intent: "question", intent_review: 1 });
  });

  it("recordLinkedInReply stores a label on insert", () => {
    const prospectId = ledger.upsertProspect({ email: `r-${randomUUID()}@example.test` });
    const id = `account:${randomUUID()}`;
    ledger.recordLinkedInReply({
      prospectId,
      source: "oneshot-linkedin",
      externalEventId: id,
      occurredAt: "2026-11-01T10:00:00Z",
      body: "No thanks",
      intent: "not_interested",
    });
    expect(
      raw(ledger)
        .query("SELECT intent, intent_review FROM channel_events WHERE external_event_id=?")
        .get(id),
    ).toEqual({ intent: "not_interested", intent_review: 0 });
  });

  it("copies a label set after delivery onto the delivered row", () => {
    const { deliver } = seedThread([message("after")]);
    deliver();
    expect(eventIntent("after")?.intent).toBeNull();
    const copied = store.setMessageIntent("account", "after", label("meeting"));
    expect(copied).toEqual([expect.objectContaining({ workspace, cadencesStopped: 0 })]);
    expect(eventIntent("after")).toEqual({ intent: "meeting", intent_review: 0 });
  });

  it("an unsubscribe opts the person out and stops their cadences; interested does not", () => {
    const optOut = seedThread([message("stop", { text: "Please stop messaging me." })]);
    const keen = seedThread([message("keen")]);
    optOut.deliver();
    keen.deliver();
    const stopCadences = vi.fn(() => 1);
    const stopped = store.setMessageIntent("account", "stop", label("unsubscribe"), {
      stopCadences,
    });
    store.setMessageIntent("account", "keen", label("interested"), { stopCadences });
    expect(stopCadences).toHaveBeenCalledTimes(1);
    expect(stopCadences).toHaveBeenCalledWith(expect.any(Ledger), optOut.prospectId);
    expect(stopped).toEqual([{ workspace, prospectId: optOut.prospectId, cadencesStopped: 1 }]);
    expect(isProspectOptedOut(raw(ledger), optOut.prospectId)).toBe(true);
    expect(isProspectOptedOut(raw(ledger), keen.prospectId)).toBe(false);
  });
});

describe("labelLinkedInReplyBatch", () => {
  beforeEach(() => {
    for (const [key, owner] of [
      ["account", workspace],
      ["theirs", "elsewhere"],
    ])
      store.saveAccount({
        key: key!,
        wallet: "wallet",
        workspace: owner!,
        account: { id: key, status: "connected", allowed_actions: [] } as never,
        sync: null,
        checkedAt: null,
        error: null,
      });
  });

  it("labels this workspace's accounts only, within the limit, and counts failures", async () => {
    store.saveMessages("account", [
      message("a", { sent_at: "2026-11-03T10:00:00Z" }),
      message("b", { sent_at: "2026-11-02T10:00:00Z" }),
      message("c", { sent_at: "2026-11-01T10:00:00Z" }),
    ] as never);
    store.saveMessages("theirs", [message("x")] as never);
    const classify = vi.fn(async () => label("interested"));
    const first = await labelLinkedInReplyBatch({ classify, limit: 2, store });
    expect(first).toMatchObject({ checked: 2, labelled: 2, failed: 0, costMicros: 24 });
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "", body: "Can you tell me more about pricing?" }),
    );
    expect(store.messageIntent("theirs", "x")).toBeNull();

    classify.mockRejectedValueOnce(new Error("model down"));
    const second = await labelLinkedInReplyBatch({ classify, limit: 25, store });
    expect(second).toMatchObject({ checked: 1, labelled: 0, failed: 1 });
    expect(store.messageIntent("account", "c")).toBeNull();
    // Backed off: nothing left this hour.
    expect((await labelLinkedInReplyBatch({ classify, store })).checked).toBe(0);
  });

  it("a dry run classifies without storing", async () => {
    store.saveMessages("account", [message("dry")] as never);
    const out = await labelLinkedInReplyBatch({
      classify: async () => label("unsubscribe"),
      store,
      dryRun: true,
    });
    expect(out.labels).toEqual([
      { accountKey: "account", messageId: "dry", intent: "unsubscribe", review: false },
    ]);
    expect(store.messageIntent("account", "dry")).toBeNull();
    expect(store.claimMessageIntent("account", "dry")).toBe(true);
  });
});
