import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkedInConversation, LinkedInMessage } from "../src/linkedin-fields.ts";
import { Ledger } from "../src/ledger.ts";
import { LinkedInInboxStore, linkedInHasConversationWith } from "../src/linkedin-inbox.ts";
import { SharedDb } from "../src/shared-db.ts";
import {
  FRIEND_INTENTS,
  FRIEND_VETO_INTENTS,
  canConnectAsFriend,
  friendReplyVerdict,
  linkedInFriendView,
} from "../src/linkedin-friend.ts";

// Everything runs against temp files: never a real ONESHOT_GTM_HOME or shared DB.

const r = (intent: string | null, review: number | null = 0, kind: string | null = "human") => ({
  kind,
  intent,
  intent_review: review,
});

describe("friendReplyVerdict", () => {
  it.each(["interested", "question", "partnership", "meeting"])("%s qualifies", (intent) => {
    expect(friendReplyVerdict([r(intent)])).toEqual({ ok: true });
  });

  it("lists exactly the four allowed and six veto labels", () => {
    expect([...FRIEND_INTENTS]).toEqual(["interested", "question", "partnership", "meeting"]);
    expect([...FRIEND_VETO_INTENTS].toSorted()).toEqual(
      [
        "complaint",
        "not_interested",
        "objection",
        "pitch_back",
        "unsubscribe",
        "wrong_person",
      ].toSorted(),
    );
  });

  it("a reply flagged for review does not qualify", () => {
    expect(friendReplyVerdict([r("interested", 1)]).ok).toBe(false);
  });

  it("an untriaged reply (NULL intent) does not qualify, and neither does a missing review flag", () => {
    expect(friendReplyVerdict([r(null)]).ok).toBe(false);
    expect(friendReplyVerdict([r("interested", null)]).ok).toBe(false);
  });

  it.each(["not_now", "intro", "auto_reply", "other"])("%s alone does not qualify", (intent) => {
    expect(friendReplyVerdict([r(intent)]).ok).toBe(false);
  });

  it("an out-of-office never counts as the human reply", () => {
    expect(friendReplyVerdict([r("interested", 0, "auto")]).ok).toBe(false);
  });

  it.each(FRIEND_VETO_INTENTS)("%s vetoes even alongside a positive reply", (veto) => {
    const verdict = friendReplyVerdict([r("interested"), r(veto)]);
    expect(verdict.ok).toBe(false);
    // Whatever the order, and even when the veto reply is itself flagged for review.
    expect(friendReplyVerdict([r(veto, 1), r("meeting")]).ok).toBe(false);
  });

  it("an unsubscribe-kind reply vetoes whatever its label", () => {
    expect(friendReplyVerdict([r("interested"), r(null, 0, "unsubscribe")]).ok).toBe(false);
  });
});

describe("canConnectAsFriend", () => {
  let dir: string;
  let ledger: Ledger;
  let shared: SharedDb;
  let inboxStore: LinkedInInboxStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linkedin-friend-"));
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    shared = new SharedDb(join(dir, "shared.sqlite"));
    inboxStore = new LinkedInInboxStore(join(dir, "linkedin-inbox.sqlite"));
  });
  afterEach(() => {
    ledger.close();
    shared.close();
    inboxStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = () => ({
    ledger,
    shared,
    inbox: { hasConversationWith: (url: string) => linkedInHasConversationWith(url, inboxStore) },
  });

  function person(over: Record<string, unknown> = {}): number {
    return ledger.upsertProspect({
      name: "Dana Lee",
      email: "dana@acme.example",
      company: "Acme",
      linkedin_url: "https://www.linkedin.com/in/dana-lee",
      source: "test",
      ...over,
    });
  }

  let n = 0;
  function reply(
    prospectId: number,
    intent: string | null,
    opts: { review?: boolean; kind?: "human" | "auto" } = {},
  ): void {
    const id = `msg-${++n}`;
    ledger.recordInboxReply({
      id,
      threadKey: `t-${id}`,
      prospectId,
      fromEmail: "dana@acme.example",
      body: "thanks for reaching out",
      receivedAt: new Date().toISOString(),
      kind: opts.kind ?? "human",
    });
    if (intent !== null) {
      ledger.setInboxReplyIntent(id, intent, "test", {
        confidence: opts.review ? 0.4 : 0.95,
        review: opts.review ?? false,
      });
    }
  }

  function conversation(slug: string, messages: number): void {
    inboxStore.saveConversation(
      "account",
      {
        id: `chat-${slug}`,
        attendees: [
          { provider_id: "ACo-self", profile_url: null, is_self: true },
          {
            provider_id: `ACo-${slug}`,
            profile_url: `https://www.linkedin.com/in/${slug}`,
            is_self: false,
          },
        ],
        attendees_synced: true,
      } as unknown as LinkedInConversation,
      [],
    );
    inboxStore.saveMessages(
      "account",
      Array.from(
        { length: messages },
        (_, i) =>
          ({
            id: `${slug}-m${i}`,
            conversation_id: `chat-${slug}`,
            direction: "outbound",
            sender_provider_id: "ACo-self",
            sender_name: "Me",
            text: "hello",
            sent_at: `2026-01-0${i + 1}T00:00:00Z`,
            deleted: false,
          }) as unknown as LinkedInMessage,
      ),
    );
  }

  it.each(FRIEND_INTENTS)("a confident %s reply qualifies, with no ICP gate", (intent) => {
    // A stored ICP reject would stop a cold invite; the reply is the qualification here.
    const id = person();
    ledger.setProspectIcpVerdict(id, "reject", "off-ICP title");
    reply(id, intent);
    expect(canConnectAsFriend(id, ctx()).ok).toBe(true);
  });

  it("a reply flagged for review does not qualify", () => {
    const id = person();
    reply(id, "interested", { review: true });
    expect(canConnectAsFriend(id, ctx()).ok).toBe(false);
  });

  it("an untriaged reply does not qualify", () => {
    const id = person();
    reply(id, null);
    expect(canConnectAsFriend(id, ctx()).ok).toBe(false);
  });

  it("someone who never replied does not qualify", () => {
    expect(canConnectAsFriend(person(), ctx()).ok).toBe(false);
  });

  it.each(FRIEND_VETO_INTENTS)("%s blocks even alongside a positive reply", (veto) => {
    const id = person();
    reply(id, "interested");
    reply(id, "meeting");
    reply(id, veto);
    expect(canConnectAsFriend(id, ctx()).ok).toBe(false);
  });

  it("is refused when their cadence was stopped, whatever they wrote", () => {
    const id = person();
    reply(id, "interested");
    ledger.enrollCadence({ prospectId: id, playName: "luma-events", nextDueAt: "2026-01-01" });
    ledger.stopCadence({ prospectId: id, playName: "luma-events", reason: "other" });
    expect(canConnectAsFriend(id, ctx())).toMatchObject({ ok: false, guard: "cadence-stopped" });
  });

  it("is refused when they already replied on LinkedIn", () => {
    const id = person();
    reply(id, "interested");
    ledger.recordLinkedInReply({
      prospectId: id,
      source: "manual",
      externalEventId: "x1",
      occurredAt: new Date().toISOString(),
      body: "hi",
    });
    expect(canConnectAsFriend(id, ctx())).toMatchObject({ ok: false, guard: "replied" });
  });

  it("an existing connection with a conversation is not offered", () => {
    const id = person();
    reply(id, "interested");
    conversation("dana-lee", 2);
    expect(canConnectAsFriend(id, ctx())).toMatchObject({
      ok: false,
      guard: "already-in-conversation",
    });
  });

  it("the invite guard applies: a name that isn't a person, a bad profile, a profile already invited", () => {
    const bot = person({ name: "SWE-agent", email: "bot@acme.example" });
    reply(bot, "interested");
    expect(canConnectAsFriend(bot, ctx())).toMatchObject({ ok: false, guard: "not-a-person" });

    const noProfile = person({
      name: "Eve Ray",
      email: "eve@acme.example",
      linkedin_url: "https://x.com/eve",
    });
    reply(noProfile, "question");
    expect(canConnectAsFriend(noProfile, ctx())).toMatchObject({
      ok: false,
      guard: "invalid-profile",
    });

    const invited = person({
      name: "Kim Ode",
      email: "kim@acme.example",
      linkedin_url: "https://www.linkedin.com/in/kim-ode",
    });
    reply(invited, "meeting");
    shared.markLinkedInTouched({ slug: "kim-ode", source: "invite:other" });
    expect(canConnectAsFriend(invited, ctx())).toMatchObject({
      ok: false,
      guard: "already-invited",
    });
  });
});

describe("linkedInFriendView", () => {
  let dir: string;
  let ledger: Ledger;
  let shared: SharedDb;
  let inboxStore: LinkedInInboxStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linkedin-friend-view-"));
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    shared = new SharedDb(join(dir, "shared.sqlite"));
    inboxStore = new LinkedInInboxStore(join(dir, "linkedin-inbox.sqlite"));
  });
  afterEach(() => {
    ledger.close();
    shared.close();
    inboxStore.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = () => ({
    ledger,
    shared,
    inbox: { hasConversationWith: (url: string) => linkedInHasConversationWith(url, inboxStore) },
  });

  function invited(over: Record<string, unknown> = {}, status: "sent" | "withdrawn" = "sent") {
    const id = ledger.upsertProspect({
      name: "Dana Lee",
      email: "dana@acme.example",
      linkedin_url: "https://www.linkedin.com/in/dana-lee",
      source: "test",
    });
    ledger.recordLinkedInInviteEvent({
      prospectId: id,
      playName: "linkedin:friend",
      stepIndex: 1,
      status: "sent",
      metadata: { invitationId: "inv-1", inviteStatus: "sent", ...over },
    });
    if (status === "withdrawn") {
      ledger.recordLinkedInInviteEvent({
        prospectId: id,
        playName: "linkedin:friend",
        stepIndex: 1,
        status: "withdrawn",
        metadata: { invitationId: "inv-1", withdrawnBy: "manual" },
      });
    }
    return id;
  }

  it("shows a sent invite as sent, and no action", () => {
    const id = invited();
    const view = linkedInFriendView(id, ctx());
    expect(view.canConnect).toBe(false);
    expect(view.invite?.state).toBe("sent");
  });

  it("shows an accepted and a withdrawn invite", () => {
    const accepted = linkedInFriendView(invited({ acceptedAt: "2026-10-01T00:00:00.000Z" }), ctx());
    expect(accepted.invite).toMatchObject({
      state: "accepted",
      acceptedAt: "2026-10-01T00:00:00.000Z",
    });
    const withdrawn = linkedInFriendView(invited({}, "withdrawn"), ctx());
    expect(withdrawn.invite?.state).toBe("withdrawn");
  });

  it("offers nothing to a thread that doesn't qualify", () => {
    const id = ledger.upsertProspect({
      name: "Dana Lee",
      email: "dana@acme.example",
      linkedin_url: "https://www.linkedin.com/in/dana-lee",
      source: "test",
    });
    expect(linkedInFriendView(id, ctx())).toMatchObject({ canConnect: false, invite: null });
  });
});
