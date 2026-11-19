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
  return { prospectId, chat, deliver: () => store.deliverAll(store.threads(), matches) };
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

    expect(store.claimMessageIntent("account", "new")).not.toBeNull();
    expect(store.claimMessageIntent("account", "new")).toBeNull();
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
    expect(store.claimMessageIntent("account", "new")).toBeNull();
    expect(store.messageIntent("account", "old")).toBeNull();
    expect([...store.conversationIntents("account", "chat").keys()]).toEqual(["new"]);
  });

  it("backs a failed message off, and gives up after three failures", () => {
    store.saveMessages("account", [message("flaky")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    const listed = (at: number) =>
      store.unlabelledReplies(["account"], { limit: 10, now: at }).length;
    expect(store.claimMessageIntent("account", "flaky", now)).not.toBeNull();
    store.recordMessageIntentFailure("account", "flaky", now);
    expect(listed(now)).toBe(0);
    expect(store.claimMessageIntent("account", "flaky", now)).toBeNull();
    // One failure waits an hour; the next waits two.
    expect(listed(now + 61 * 60_000)).toBe(1);
    store.recordMessageIntentFailure("account", "flaky", now);
    expect(listed(now + 61 * 60_000)).toBe(0);
    expect(listed(now + 121 * 60_000)).toBe(1);
    store.recordMessageIntentFailure("account", "flaky", now);
    expect(listed(now + 24 * 60 * 60_000)).toBe(0);
    expect(store.claimMessageIntent("account", "flaky", now + 24 * 60 * 60_000)).toBeNull();
  });

  it("--retry-failed gives an exhausted message its attempts back", () => {
    store.saveMessages("account", [message("flaky"), message("fine")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    for (let i = 0; i < 3; i++) store.recordMessageIntentFailure("account", "flaky", now);
    const later: { limit: number; now: number; includeExhausted?: boolean } = {
      limit: 10,
      now: now + 24 * 60 * 60_000,
    };
    const ids = (opts = later) =>
      store.unlabelledReplies(["account"], opts).map((r) => r.message.id);
    expect(ids()).toEqual(["fine"]);
    expect(store.exhaustedReplyCount(["account"])).toBe(1);
    // A dry run lists it without writing; it stays exhausted.
    expect(ids({ ...later, includeExhausted: true }).toSorted()).toEqual(["fine", "flaky"]);
    expect(store.exhaustedReplyCount(["account"])).toBe(1);
    expect(store.resetExhaustedReplies(["account"])).toBe(1);
    expect(store.exhaustedReplyCount(["account"])).toBe(0);
    expect(ids({ limit: 10, now }).toSorted()).toEqual(["fine", "flaky"]);
  });

  it("a completion whose claim lapsed never replaces the label of the caller that retook it", () => {
    store.saveMessages("account", [message("slow")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    const first = store.claimMessageIntent("account", "slow", now);
    const second = store.claimMessageIntent("account", "slow", now + 6 * 60_000);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const at = now + 7 * 60_000;
    // The first caller finishes while the second still holds the claim: nothing is written.
    expect(
      store.setMessageIntent("account", "slow", label("question"), { claim: first, now: at }),
    ).toBe(null);
    store.recordMessageIntentFailure("account", "slow", at, first);
    expect(store.messageIntent("account", "slow")).toBeNull();
    expect(
      store.setMessageIntent("account", "slow", label("meeting"), { claim: second, now: at }),
    ).toEqual([]);
    expect(
      store.setMessageIntent("account", "slow", label("question"), { claim: first, now: at }),
    ).toBe(null);
    // Nor does a write without a claim replace a stored label.
    expect(store.setMessageIntent("account", "slow", label("unsubscribe"))).toBe(null);
    expect(store.messageIntent("account", "slow")?.intent).toBe("meeting");
    expect(
      store.db.query("SELECT attempts FROM message_intents WHERE message_id='slow'").get(),
    ).toEqual({ attempts: 0 });
  });

  it("an expired claim nobody retook writes no label and counts no failure", () => {
    store.saveMessages("account", [message("late")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    const claim = store.claimMessageIntent("account", "late", now);
    const expired = now + 6 * 60_000;
    expect(
      store.setMessageIntent("account", "late", label("unsubscribe"), { claim, now: expired }),
    ).toBe(null);
    store.recordMessageIntentFailure("account", "late", expired, claim);
    expect(store.messageIntent("account", "late")).toBeNull();
    expect(
      store.db.query("SELECT attempts FROM message_intents WHERE message_id='late'").get(),
    ).toEqual({ attempts: 0 });
    // Free to claim again.
    expect(store.claimMessageIntent("account", "late", expired)).not.toBeNull();
  });

  it("a claimed label is not stored once its message was deleted or edited", () => {
    store.saveMessages("account", [message("edited"), message("deleted")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    const text = message("edited").text;
    const edited = store.claimMessageIntent("account", "edited", now);
    const deleted = store.claimMessageIntent("account", "deleted", now);
    store.saveMessages("account", [
      message("edited", { text: "Actually, not now." }),
      message("deleted", { deleted: true }),
    ] as never);
    const at = { now: now + 60_000, text };
    expect(
      store.setMessageIntent("account", "edited", label("interested"), { claim: edited, ...at }),
    ).toBe(null);
    expect(
      store.setMessageIntent("account", "deleted", label("interested"), { claim: deleted, ...at }),
    ).toBe(null);
    expect(store.messageIntent("account", "edited")).toBeNull();
    expect(store.messageIntent("account", "deleted")).toBeNull();
  });

  it("pages past automatic replies to fill the batch", () => {
    store.saveMessages("account", [
      ...Array.from({ length: 150 }, (_, i) =>
        message(`auto-${i}`, {
          text: "I am currently out of the office until Monday.",
          sent_at: `2026-11-10T10:${String(i % 60).padStart(2, "0")}:00Z`,
        }),
      ),
      message("human", { sent_at: "2026-10-01T10:00:00Z" }),
    ] as never);
    expect(store.unlabelledReplies(["account"], { limit: 1 }).map((r) => r.message.id)).toEqual([
      "human",
    ]);
  });

  it("a claimed failure for a row merged away meanwhile does not revive it", () => {
    store.saveMessages("account", [message("merged")] as never);
    const now = Date.parse("2026-11-18T12:00:00Z");
    const claim = store.claimMessageIntent("account", "merged", now);
    store.db.query("DELETE FROM message_intents WHERE message_id='merged'").run();
    store.recordMessageIntentFailure("account", "merged", now + 60_000, claim);
    expect(
      store.db.query("SELECT count(*) AS n FROM message_intents WHERE message_id='merged'").get(),
    ).toEqual({ n: 0 });
  });

  it("claims only a message the store still holds, undeleted", () => {
    store.saveMessages("account", [message("removed", { deleted: true })] as never);
    expect(store.claimMessageIntent("account", "removed")).toBeNull();
    expect(store.claimMessageIntent("account", "never-saved")).toBeNull();
    expect(
      store.db
        .query("SELECT count(*) AS n FROM message_intents WHERE message_id='never-saved'")
        .get(),
    ).toEqual({ n: 0 });
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

  it("an unsubscribe on a reply imported from another tool labels the imported row", () => {
    const text = "Please stop messaging me.";
    const optOut = seedThread([message("imported", { text })]);
    ledger.recordLinkedInReply({
      prospectId: optOut.prospectId,
      source: "other-tool",
      externalEventId: `other-tool:${randomUUID()}`,
      occurredAt: "2026-11-01T10:00:00Z",
      body: text,
    });
    optOut.deliver();
    expect(eventIntent("imported")).toBeNull();
    // Edited after delivery: the imported row is found by the id recorded then.
    store.saveMessages("account", [
      { ...message("imported", { text: "Please stop." }), conversation_id: optOut.chat },
    ] as never);
    expect(store.messages("account", optOut.chat)[0]?.text).toBe("Please stop.");
    const stopCadences = vi.fn(() => 0);
    store.setMessageIntent("account", "imported", label("unsubscribe"), { stopCadences });
    expect(stopCadences).toHaveBeenCalledWith(expect.any(Ledger), optOut.prospectId);
    expect(
      raw(ledger)
        .query("SELECT intent FROM channel_events WHERE source='other-tool' AND prospect_id=?")
        .get(optOut.prospectId),
    ).toEqual({ intent: "unsubscribe" });
    expect(isProspectOptedOut(raw(ledger), optOut.prospectId)).toBe(true);
  });

  it("a delivery whose ledger row took no label stays pending", () => {
    const { deliver } = seedThread([message("lost")]);
    deliver();
    raw(ledger).query("DELETE FROM channel_events WHERE external_event_id='account:lost'").run();
    expect(store.setMessageIntent("account", "lost", label("meeting"))).toHaveLength(1);
    expect(
      store.db.query("SELECT count(*) AS n FROM label_copies WHERE message_id='lost'").get(),
    ).toEqual({ n: 0 });
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

  it("a slow classify whose claim was retaken keeps the other caller's label", async () => {
    store.saveMessages("account", [message("slow")] as never);
    const out = await labelLinkedInReplyBatch({
      classify: async () => {
        // Another server retakes the lapsed claim and stores its label first.
        const claim = store.claimMessageIntent("account", "slow", Date.now() + 6 * 60_000);
        store.setMessageIntent("account", "slow", label("meeting"), { claim });
        return label("unsubscribe");
      },
      store,
    });
    expect(out).toMatchObject({ labelled: 0, skipped: 1, labels: [] });
    expect(store.messageIntent("account", "slow")?.intent).toBe("meeting");
  });

  it("a claimed completion for a message merged away meanwhile stores nothing", async () => {
    store.saveMessages("account", [message("gone")] as never);
    const out = await labelLinkedInReplyBatch({
      classify: async () => {
        // Reconciliation moved the claimed row to the kept message.
        store.db.query("DELETE FROM message_intents WHERE message_id='gone'").run();
        return label("interested");
      },
      store,
    });
    expect(out).toMatchObject({ labelled: 0, skipped: 1 });
    expect(
      store.db.query("SELECT count(*) AS n FROM message_intents WHERE message_id='gone'").get(),
    ).toEqual({ n: 0 });
  });

  it("a label whose row could not be written counts as a failure, not a label", async () => {
    store.saveMessages("account", [message("broken")] as never);
    vi.spyOn(store, "setMessageIntent").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    const out = await labelLinkedInReplyBatch({ classify: async () => label("meeting"), store });
    expect(out).toMatchObject({ labelled: 0, failed: 1, labels: [] });
    expect(store.messageIntent("account", "broken")).toBeNull();
  });

  it("a failure that cannot be recorded still returns the batch's results", async () => {
    store.saveMessages("account", [
      message("ok", { sent_at: "2026-11-03T10:00:00Z" }),
      message("bad", { sent_at: "2026-11-02T10:00:00Z" }),
    ] as never);
    vi.spyOn(store, "recordMessageIntentFailure").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const classify = vi.fn(async (e: { id?: string }) => {
      if (e.id?.endsWith(":bad")) throw new Error("model down");
      return label("question");
    });
    const out = await labelLinkedInReplyBatch({ classify, store });
    expect(out).toMatchObject({ checked: 2, labelled: 1, failed: 1 });
    expect(store.messageIntent("account", "ok")?.intent).toBe("question");
  });

  it("a reply merged away while an earlier one is classified is not claimed or paid for", async () => {
    store.saveMessages("account", [
      message("first", { sent_at: "2026-11-03T10:00:00Z" }),
      message("dupe", { sent_at: "2026-11-02T10:00:00Z" }),
    ] as never);
    const classify = vi.fn(async () => {
      // Reconciliation merges the later batch item into an already-labelled message.
      store.db.query("DELETE FROM messages WHERE id='dupe'").run();
      return label("question");
    });
    const out = await labelLinkedInReplyBatch({ classify, store });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ checked: 2, labelled: 1, skipped: 1 });
    expect(
      store.db.query("SELECT count(*) AS n FROM message_intents WHERE message_id='dupe'").get(),
    ).toEqual({ n: 0 });
  });

  it("a classify call that outlives its time is a failure, and its late label is never stored", async () => {
    store.saveMessages("account", [message("stalled")] as never);
    let finish: ((l: LinkedInReplyLabel) => void) | undefined;
    const out = await labelLinkedInReplyBatch({
      classify: () => new Promise((done) => (finish = done)),
      store,
      classifyTimeoutMs: 10,
    });
    expect(out).toMatchObject({ labelled: 0, failed: 1 });
    finish?.(label("interested"));
    await Promise.resolve();
    expect(store.messageIntent("account", "stalled")).toBeNull();
    expect(
      store.db.query("SELECT attempts FROM message_intents WHERE message_id='stalled'").get(),
    ).toEqual({ attempts: 1 });
  });

  it("an opt-out stop that failed is retried on the next pass until it completes", async () => {
    const optOut = seedThread([message("stop", { text: "Please stop messaging me." })]);
    optOut.deliver();
    const stopCadences = vi
      .fn<(l: Ledger, prospectId: number) => number>()
      .mockImplementationOnce(() => {
        throw new Error("database is locked");
      })
      .mockImplementation(() => 2);
    const classify = vi.fn(async () => label("unsubscribe"));
    const first = await labelLinkedInReplyBatch({ classify, stopCadences, store });
    expect(first).toMatchObject({ labelled: 1, cadencesStopped: 0 });
    expect(store.messageIntent("account", "stop")?.intent).toBe("unsubscribe");

    const second = await labelLinkedInReplyBatch({ classify, stopCadences, store });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ checked: 0, cadencesStopped: 2 });
    expect(stopCadences).toHaveBeenCalledTimes(2);
    expect(stopCadences).toHaveBeenLastCalledWith(expect.any(Ledger), optOut.prospectId);

    // Done: never stopped again.
    await labelLinkedInReplyBatch({ classify, stopCadences, store });
    expect(stopCadences).toHaveBeenCalledTimes(2);
  });

  it("an opt-out labelled before its reply was delivered stops cadences once delivered", async () => {
    const optOut = seedThread([message("predelivery", { text: "Please stop messaging me." })]);
    const stopCadences = vi.fn(() => 1);
    await labelLinkedInReplyBatch({
      classify: async () => label("unsubscribe"),
      stopCadences,
      store,
    });
    expect(stopCadences).not.toHaveBeenCalled();
    optOut.deliver();
    const out = await labelLinkedInReplyBatch({
      classify: async () => label("unsubscribe"),
      stopCadences,
      store,
    });
    expect(out.cadencesStopped).toBe(1);
    expect(stopCadences).toHaveBeenCalledWith(expect.any(Ledger), optOut.prospectId);
    expect(eventIntent("predelivery")?.intent).toBe("unsubscribe");
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
    expect(store.claimMessageIntent("account", "dry")).not.toBeNull();
  });
});
