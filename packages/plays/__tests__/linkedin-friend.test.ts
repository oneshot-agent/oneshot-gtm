import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let modelNote = "We traded emails last week. Connecting here so the next hello isn't cold.";
const completeInputs: string[] = [];

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      completeInputs.push(input.messages[1]!.content);
      return { content: modelNote };
    },
  };
});

const core = await import("@oneshot-gtm/core");
const { draftFriendNote, sendFriendInvite, FRIEND_NOTE_MAX_CHARS } =
  await import("../src/_linkedin-friend.ts");
const { LINKEDIN_FRIEND_PLAY, LINKEDIN_FRIEND_STEP_INDEX } =
  await import("@oneshot-gtm/shared-types");

// A real ledger, shared DB and inbox store in the isolated test home
// (vitest.setup.ts): never a real config. The LinkedIn client is a stub.

let seq = 0;
function sender(result: unknown = { invitation_id: "inv-1", status: "sent" }) {
  const calls: Array<{ kind: string } & Record<string, unknown>> = [];
  return {
    calls,
    sender: {
      accountId: "acct-1",
      workspace: "gtm",
      call: async (op: unknown) => {
        calls.push(op as never);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

/** A prospect with one email reply labelled `intent`, confident unless `review`. */
function replier(
  intent: string | null,
  opts: { review?: boolean; extra?: Array<string | null> } = {},
): number {
  const n = ++seq;
  const ledger = core.getLedger();
  const id = ledger.upsertProspect({
    name: `${["Dana", "Eli", "Fay", "Gus", "Hana", "Ivo"][n % 6]!} Lee`,
    email: `person${n}@example.test`,
    company: "Acme",
    linkedin_url: `https://www.linkedin.com/in/person-${n}`,
    source: "test",
  });
  for (const [i, label] of [intent, ...(opts.extra ?? [])].entries()) {
    const mid = `friend-${n}-${i}`;
    ledger.recordInboxReply({
      id: mid,
      threadKey: `t-${mid}`,
      prospectId: id,
      playName: "luma-events",
      fromEmail: `person${n}@example.test`,
      subject: "Re: your note",
      body: "Thanks, happy to talk about how we handle review.",
      receivedAt: new Date().toISOString(),
      kind: "human",
    });
    if (label !== null) {
      ledger.setInboxReplyIntent(mid, label, "test", {
        confidence: opts.review && i === 0 ? 0.4 : 0.95,
        review: Boolean(opts.review && i === 0),
      });
    }
  }
  return id;
}

const invites = (calls: Array<{ kind: string }>) => calls.filter((c) => c.kind === "invite");

beforeEach(() => {
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "linkedin-friend-play-"));
  core._resetInviteLimitsCacheForTests();
  core.saveConfig({ ...core.loadConfig(), linkedin: undefined });
  modelNote = "We traded emails last week. Connecting here so the next hello isn't cold.";
  completeInputs.length = 0;
});

describe("sendFriendInvite", () => {
  it("sends a reviewed note and records it at a non-zero step with the marker", async () => {
    const id = replier("interested");
    const { sender: s, calls } = sender();
    const out = await sendFriendInvite({
      prospectId: id,
      note: "We traded emails. Connecting so the next hello isn't cold.",
      sender: s,
      workspace: "gtm",
    });
    expect(out).toEqual({ sent: true, status: "sent", invitationId: "inv-1" });
    expect(invites(calls)).toHaveLength(1);
    expect(invites(calls)[0]).toMatchObject({
      note: "We traded emails. Connecting so the next hello isn't cold.",
      playName: LINKEDIN_FRIEND_PLAY,
      idempotencyKey: `gtm:gtm:cadence:${id}:${LINKEDIN_FRIEND_PLAY}:${LINKEDIN_FRIEND_STEP_INDEX}:invite`,
    });

    const events = core.getLedger().listLinkedInInviteEvents(id, LINKEDIN_FRIEND_PLAY);
    expect(events).toHaveLength(1);
    expect(events[0]!.step_index).toBe(LINKEDIN_FRIEND_STEP_INDEX);
    expect(events[0]!.step_index).toBeGreaterThan(0);
    expect(events[0]!.channel).toBe("linkedin");
    expect(events[0]!.status).toBe("sent");
    expect(JSON.parse(events[0]!.metadata_json!)).toMatchObject({
      kind: "linkedin_invite",
      invitationId: "inv-1",
      accountId: "acct-1",
    });
  });

  it("creates no follow-up: no cadence, no later step, nothing due", async () => {
    const id = replier("meeting");
    const { sender: s } = sender();
    await sendFriendInvite({ prospectId: id, note: "hello", sender: s, workspace: "gtm" });
    const ledger = core.getLedger();
    expect(ledger.getCadence(id, LINKEDIN_FRIEND_PLAY)).toBeNull();
    expect(ledger.listSequenceEventsForProspectPlay(id, LINKEDIN_FRIEND_PLAY)).toHaveLength(1);
    const all = ledger.listAllCadences().filter((c) => c.prospect_id === id);
    expect(all).toEqual([]);
  });

  it("is never a first touch: no step 0 for the prospect", async () => {
    const id = replier("partnership");
    const { sender: s } = sender();
    await sendFriendInvite({ prospectId: id, note: "hello", sender: s, workspace: "gtm" });
    const steps = core
      .getLedger()
      .listSequenceEventsForProspectPlay(id, LINKEDIN_FRIEND_PLAY)
      .map((e) => e.step_index);
    expect(steps).not.toContain(0);
  });

  it.each([
    "unsubscribe",
    "wrong_person",
    "complaint",
    "not_interested",
    "objection",
    "pitch_back",
  ])("never sends to someone with a %s reply, even next to a positive one", async (veto) => {
    const id = replier("interested", { extra: [veto] });
    const { sender: s, calls } = sender();
    const out = await sendFriendInvite({ prospectId: id, note: "hi", sender: s, workspace: "gtm" });
    expect(out.sent).toBe(false);
    expect(calls).toHaveLength(0);
    expect(core.getLedger().listLinkedInInviteEvents(id, LINKEDIN_FRIEND_PLAY)).toHaveLength(0);
  });

  it("never sends on a review-flagged or untriaged label", async () => {
    const { sender: s, calls } = sender();
    for (const id of [replier("interested", { review: true }), replier(null)]) {
      const out = await sendFriendInvite({
        prospectId: id,
        note: "hi",
        sender: s,
        workspace: "gtm",
      });
      expect(out.sent).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an edited note with a question, pitch or link before anything is sent", async () => {
    const id = replier("interested");
    const { sender: s, calls } = sender();
    const notes = [
      "Are we still on for next week?",
      "We built a tool that fits you well.",
      "More at https://example.com/me",
    ];
    for (const [i, note] of notes.entries()) {
      const out = await sendFriendInvite({ prospectId: id, note, sender: s, workspace: "gtm" });
      expect(out.sent).toBe(false);
      expect((out as { flags: string[] }).flags[0]).toMatch(
        [/^note-question:/, /^note-pitch:/, /^note-link:/][i]!,
      );
    }
    expect(calls).toHaveLength(0);
    expect(core.getLedger().listLinkedInInviteEvents(id, LINKEDIN_FRIEND_PLAY)).toHaveLength(0);
  });

  it("the guard applies: a profile already invited is refused and nothing is sent", async () => {
    const id = replier("interested");
    core.getSharedDb().markLinkedInTouched({ slug: `person-${seq}`, source: "invite:other" });
    const { sender: s, calls } = sender();
    const out = await sendFriendInvite({ prospectId: id, note: "hi", sender: s, workspace: "gtm" });
    expect(out.sent).toBe(false);
    expect((out as { flags: string[] }).flags[0]).toMatch(/^already-invited:/);
    expect(calls).toHaveLength(0);
  });

  it("an existing connection with a conversation is not invited", async () => {
    const id = replier("interested");
    const store = core.getLinkedInInboxStore();
    store.saveConversation(
      "acct-key",
      {
        id: `chat-${id}`,
        attendees: [
          { provider_id: "ACo-self", profile_url: null, is_self: true },
          {
            provider_id: `ACo-${id}`,
            profile_url: `https://www.linkedin.com/in/person-${seq}`,
            is_self: false,
          },
        ],
        attendees_synced: true,
      } as never,
      [],
    );
    store.saveMessages("acct-key", [
      {
        id: `m-${id}`,
        conversation_id: `chat-${id}`,
        direction: "outbound",
        sender_provider_id: "ACo-self",
        sender_name: "Me",
        text: "good to see you",
        sent_at: "2026-01-01T00:00:00Z",
        deleted: false,
      } as never,
    ]);
    const { sender: s, calls } = sender();
    const out = await sendFriendInvite({ prospectId: id, note: "hi", sender: s, workspace: "gtm" });
    expect(out.sent).toBe(false);
    expect((out as { flags: string[] }).flags[0]).toMatch(/^already-in-conversation:/);
    expect(invites(calls)).toHaveLength(0);
  });

  it("counts against the workspace's invite share and is deferred when it is used up", async () => {
    core.saveConfig({ ...core.loadConfig(), linkedin: { invitesPerDay: 1 } });
    core._resetInviteLimitsCacheForTests();
    const { sender: s, calls } = sender();
    const first = await sendFriendInvite({
      prospectId: replier("interested"),
      note: "hi",
      sender: s,
      workspace: "gtm",
    });
    expect(first.sent).toBe(true);
    const second = await sendFriendInvite({
      prospectId: replier("question"),
      note: "hi",
      sender: s,
      workspace: "gtm",
    }).catch((e: unknown) => e);
    expect(core.isSendDeferred(second)).toBe(true);
    expect(invites(calls)).toHaveLength(1);
  });

  it("never sends an empty note or one over LinkedIn's limit", async () => {
    const { sender: s, calls } = sender();
    const id = replier("interested");
    expect(
      await sendFriendInvite({ prospectId: id, note: "  ", sender: s, workspace: "gtm" }),
    ).toMatchObject({
      sent: false,
    });
    expect(
      await sendFriendInvite({
        prospectId: id,
        note: "x".repeat(FRIEND_NOTE_MAX_CHARS + 1),
        sender: s,
        workspace: "gtm",
      }),
    ).toMatchObject({ sent: false });
    expect(calls).toHaveLength(0);
  });
});

describe("draftFriendNote", () => {
  it("drafts in friend mode from the email exchange, with no pitch or question, and sends nothing", async () => {
    const id = replier("interested");
    const out = await draftFriendNote(id);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.note).toBe(modelNote);
    expect(out.draft.flags).toEqual([]);
    expect(out.draft.maxChars).toBe(300);
    expect(completeInputs[0]).toContain("MODE: friend");
    expect(completeInputs[0]).toContain("MAX_CHARS: 300");
    expect(completeInputs[0]).toContain("EMAIL_EXCHANGE:");
    expect(completeInputs[0]).toContain("Thanks, happy to talk");
    expect(completeInputs[0]).not.toContain("SIGNAL:");
    expect(core.getLedger().listLinkedInInviteEvents(id, LINKEDIN_FRIEND_PLAY)).toHaveLength(0);
  });

  it("flags a question, a pitch phrase and a link, and one over the limit", async () => {
    const id = replier("interested");
    modelNote = "We traded emails, can I show you what we built at https://acme.example?";
    const out = await draftFriendNote(id);
    expect(out.ok && out.draft.flags.some((f) => f.startsWith("note-question"))).toBe(true);
    expect(out.ok && out.draft.flags.some((f) => f.startsWith("note-pitch"))).toBe(true);
    expect(out.ok && out.draft.flags.some((f) => f.startsWith("note-link"))).toBe(true);
    modelNote = "x".repeat(320);
    const long = await draftFriendNote(id);
    expect(long.ok && long.draft.flags.some((f) => f.startsWith("note-too-long"))).toBe(true);
  });

  it("refuses to draft for someone who does not qualify, without calling the model", async () => {
    const out = await draftFriendNote(replier("interested", { extra: ["complaint"] }));
    expect(out.ok).toBe(false);
    expect(completeInputs).toHaveLength(0);
  });
});
