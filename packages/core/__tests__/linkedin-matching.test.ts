import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { LinkedInConversation, LinkedInMessage } from "@oneshot-agent/sdk";
import { Ledger } from "../src/ledger.ts";
import { LinkedInInboxStore, type LinkedInMatch } from "../src/linkedin-inbox.ts";
let store: LinkedInInboxStore;
let ledgers: Ledger[];
let matches: LinkedInMatch[];
const conversation = (attendees: unknown[] = []): LinkedInConversation =>
  ({ id: "chat", attendees, attendees_synced: false }) as LinkedInConversation;
const message = (extra = {}): LinkedInMessage =>
  ({
    id: "reply",
    conversation_id: "chat",
    direction: "inbound",
    sender_provider_id: "ACo-internal",
    sender_name: "Ada",
    text: "Tell me more",
    sent_at: "2020-01-01T00:00:00Z",
    deleted: false,
    ...extra,
  }) as LinkedInMessage;
const attendee = (id: string, slug: string) => ({
  provider_id: id,
  profile_url: `https://linkedin.com/in/${slug}`,
  is_self: false,
});
beforeEach(() => {
  store = new LinkedInInboxStore(
    join(process.env.ONESHOT_GTM_HOME!, `matching-${crypto.randomUUID()}.sqlite`),
  );
  ledgers = [];
  matches = [];
  for (const workspace of ["gtm", "sdk"]) {
    const home = join(process.env.ONESHOT_GTM_HOME!, `${workspace}-${crypto.randomUUID()}`);
    mkdirSync(home);
    const ledger = new Ledger(join(home, "ledger.sqlite"));
    ledgers.push(ledger);
    const prospectId = ledger.upsertProspect({
      email: "ada@example.test",
      name: "Ada",
      linkedin_url: "https://linkedin.com/in/ada",
    });
    matches.push({ workspace, home, prospectId, name: "Ada", profile: "linkedin.com/in/ada" });
    ledger.enrollCadence({ prospectId, playName: "outreach", nextDueAt: "2030-01-01" });
    ledger.setCadenceDraft({
      prospectId,
      playName: "outreach",
      draft: { subject: "hi", body: "follow-up", flags: [], payload: {} },
    });
    ledger.enqueueTarget({
      playName: "breakup-revive",
      dedupeKey: `prospect:${prospectId}`,
      payload: { email: "ada@example.test" },
      source: "breakup-revive",
    });
  }
});
afterEach(() => {
  store.close();
  for (const ledger of ledgers) ledger.close();
});
function resolve() {
  store.saveIdentity("account", {
    providerId: "ACo-internal",
    profile: "linkedin.com/in/ada",
    name: "Ada",
    resolvedAt: "2026-01-01",
  });
}
function deliver(c = conversation(), m = message(), list = matches) {
  store.saveConversation("account", c, list);
  store.saveMessages("account", [m]);
  store.saveConversation("account", c, list);
  store.deliverAll(store.threads(), list);
}
it("resolves internal senders with missing attendees, stops both workspaces, and clears drafts/queues without claiming ownership", () => {
  resolve();
  const pausedDb = new Database(join(matches[1]!.home, "ledger.sqlite"));
  pausedDb
    .query("UPDATE cadence_state SET status='paused' WHERE prospect_id=?")
    .run(matches[1]!.prospectId);
  pausedDb.close();
  deliver();
  expect(store.threads()[0]!.owner).toBeNull();
  expect(store.threads()[0]!.conversation.attendees_synced).toBe(false);
  expect(store.threads()[0]!.conversation.attendees).toEqual([]);
  for (const [i, ledger] of ledgers.entries()) {
    const id = matches[i]!.prospectId;
    expect(ledger.getCadence(id, "outreach")).toMatchObject({
      status: "replied",
      next_due_at: null,
      next_step_draft_json: null,
    });
    expect(
      ledger.draftVersionsFor({ prospectId: id, playName: "outreach", stepIndex: 1 })[0]?.outcome,
    ).toBe("discarded");
    expect(ledger.listChannelEventsForProspect(id)).toHaveLength(0);
    const db = new Database(join(matches[i]!.home, "ledger.sqlite"));
    expect(
      db.query("SELECT status FROM target_queue WHERE play_name='breakup-revive'").get(),
    ).toEqual({ status: "expired" });
    db.close();
  }
});
it("names never establish identity", () => {
  deliver();
  for (const [i, ledger] of ledgers.entries())
    expect(ledger.getCadence(matches[i]!.prospectId, "outreach")?.status).toBe("active");
});
it("a group reply stops only the verified sender, not silent participants", () => {
  const other = ledgers[0]!.upsertProspect({
    email: "bob@example.test",
    name: "Ada",
    linkedin_url: "https://linkedin.com/in/bob",
  });
  ledgers[0]!.enrollCadence({ prospectId: other, playName: "outreach", nextDueAt: "2030-01-01" });
  matches.push({ ...matches[0]!, prospectId: other, profile: "linkedin.com/in/bob" });
  deliver(conversation([attendee("ACo-internal", "ada"), attendee("bob-id", "bob")]));
  expect(ledgers[0]!.getCadence(other, "outreach")?.status).toBe("active");
  expect(ledgers[0]!.getCadence(matches[0]!.prospectId, "outreach")?.status).toBe("replied");
});
it.each([{ deleted: true }, { text: "I am currently out of office" }, { direction: "outbound" }])(
  "ignores deleted/automated/outbound messages: %j",
  (extra) => {
    resolve();
    deliver(conversation(), message(extra));
    expect(ledgers[0]!.getCadence(matches[0]!.prospectId, "outreach")?.status).toBe("active");
  },
);
it("replaying an existing historical reply stops a later cadence without duplicating history", () => {
  resolve();
  deliver(conversation(), message(), [matches[0]!]);
  const ledger = ledgers[0]!,
    id = matches[0]!.prospectId;
  ledger.enrollCadence({ prospectId: id, playName: "new-play", nextDueAt: "2030-01-01" });
  deliver(conversation(), message(), [matches[0]!]);
  expect(ledger.getCadence(id, "new-play")?.status).toBe("replied");
  expect(ledger.listChannelEventsForProspect(id)).toHaveLength(1);
});
it("preserves manual ownership and old reply events when new matches become ambiguous", () => {
  resolve();
  deliver(conversation(), message(), [matches[0]!]);
  store.assign("linkedin:account:chat", { workspace: "sdk", prospectId: matches[1]!.prospectId });
  deliver();
  expect(store.threads()[0]!.owner).toMatchObject({ workspace: "sdk", manual: true });
  expect(ledgers[0]!.listChannelEventsForProspect(matches[0]!.prospectId)).toHaveLength(1);
  expect(ledgers[1]!.listChannelEventsForProspect(matches[1]!.prospectId)).toHaveLength(1);
});
it("does not give an unknown sender another attendee's identity", () => {
  deliver(conversation([attendee("someone-else", "ada")]));
  expect(ledgers[0]!.getCadence(matches[0]!.prospectId, "outreach")?.status).toBe("active");
});
it("human opt-outs also stop historical outreach", () => {
  resolve();
  deliver(conversation(), message({ text: "Please do not contact me" }));
  expect(ledgers[0]!.getCadence(matches[0]!.prospectId, "outreach")?.status).toBe("replied");
});

it("does not treat an internal ID disguised as a profile URL as resolved identity", () => {
  const c = conversation([attendee("ACo-internal", "ACo-internal")]);
  store.saveMessages("account", [message()]);
  expect(store.senderProfile("account", c, message())).toBeNull();
  resolve();
  expect(store.senderProfile("account", c, message())).toBe("linkedin.com/in/ada");
});

it("removes only newly duplicated reply events after replacement and preserves original and manual history", () => {
  for (const [i, ledger] of ledgers.entries()) {
    const prospectId = matches[i]!.prospectId;
    for (const externalEventId of ["account:original", "account:duplicate"])
      ledger.recordLinkedInReply({
        prospectId,
        source: "oneshot-linkedin",
        externalEventId,
        occurredAt: "2020-01-01",
        body: "Tell me more",
      });
    ledger.recordLinkedInReply({
      prospectId,
      source: "manual",
      externalEventId: "hand-marked",
      occurredAt: "2020-01-01",
      body: "Tell me more",
    });
  }
  store.db
    .query("INSERT INTO message_redirects VALUES(?,?,?)")
    .run("account", "duplicate", "original");
  store.deliverAll([], matches);
  store.deliverAll([], matches);
  for (const [i, ledger] of ledgers.entries()) {
    const events = ledger.listChannelEventsForProspect(matches[i]!.prospectId);
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.source === "manual")).toBe(true);
    expect(events.some((e) => e.external_event_id === "account:original")).toBe(true);
  }
});
