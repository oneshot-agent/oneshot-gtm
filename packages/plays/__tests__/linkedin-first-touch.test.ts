import { beforeEach, describe, expect, it, vi } from "vitest";

let modelNote = "Saw you hosted GTM in git — how are you handling review?";
const completeInputs: string[] = [];
const upserts: Array<Record<string, unknown>> = [];
const events: Array<Record<string, unknown>> = [];
const enrollments: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ founderName: "Founder", productOneLiner: "a GTM workspace" }),
    logEvent: () => {},
    getLedger: () => ({
      upsertProspect: (input: Record<string, unknown>) => {
        upserts.push(input);
        return 42;
      },
      recordSequenceEvent: (input: Record<string, unknown>) => {
        events.push(input);
      },
      enrollCadence: (input: Record<string, unknown>) => {
        enrollments.push(input);
      },
      getCadence: () => ({ enrolled_at: "2026-09-27 00:00:00", channel: "linkedin" }),
      getCadencePlan: () => null,
      saveCadencePlan: () => {},
    }),
  };
});
vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "note prompt",
  complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
    completeInputs.push(input.messages[1]!.content);
    return { content: modelNote };
  },
}));

const { draftLinkedInNote, sendLinkedInInvite } = await import("../src/_linkedin-first-touch.ts");
const { isSendDeferred } = await import("@oneshot-gtm/core");

function row(payload: Record<string, unknown> = {}) {
  return {
    id: 7,
    playName: "luma-events",
    payload: {
      name: "Dana Lee",
      company: "Acme",
      linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      eventTitle: "GTM in git",
      role: "Host",
      ...payload,
    },
    notes: "Dana Lee hosting GTM in git",
  };
}

function sender(result: unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    sender: {
      accountId: "acct-1",
      workspace: "gtm",
      call: async (op: unknown) => {
        calls.push(op);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

beforeEach(() => {
  modelNote = "Saw you hosted GTM in git — how are you handling review?";
  completeInputs.length = 0;
  upserts.length = 0;
  events.length = 0;
  enrollments.length = 0;
});

describe("draftLinkedInNote", () => {
  it("drafts from the row's signal and passes the character limit", async () => {
    const note = await draftLinkedInNote(row());
    expect(note.body).toBe(modelNote);
    expect(note.flags).toEqual([]);
    expect(note.subject).toBe("LinkedIn invite → Dana Lee");
    expect(completeInputs[0]).toContain("EVENT: GTM in git (hosting)");
    expect(completeInputs[0]).toContain("MAX_CHARS: 200");
  });

  it("flags a note over the limit and a row without a LinkedIn profile", async () => {
    modelNote = "x".repeat(230);
    const note = await draftLinkedInNote(row({ linkedinUrl: "https://acme.com" }));
    expect(note.flags).toEqual([
      "note-too-long: 230/200 characters",
      "no-linkedin: this row has no LinkedIn profile URL",
    ]);
  });
});

describe("sendLinkedInInvite", () => {
  it("sends the note, records the prospect and a step-0 LinkedIn event", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" });
    expect(out).toEqual({ sent: true, status: "sent", invitationId: "inv-1", prospectId: 42 });
    expect(calls[0]).toMatchObject({
      kind: "invite",
      accountId: "acct-1",
      profile: "https://www.linkedin.com/in/dana-lee",
      note: "hi",
      idempotencyKey: "gtm:gtm:queue:7:invite",
    });
    expect(upserts[0]).toMatchObject({
      email: null,
      linkedin_url: "https://www.linkedin.com/in/dana-lee",
    });
    expect(events[0]).toMatchObject({
      prospectId: 42,
      stepIndex: 0,
      channel: "linkedin",
      status: "sent",
      metadata: {
        note: "hi",
        body: "hi",
        invitationId: "inv-1",
        inviteStatus: "sent",
        accountId: "acct-1",
        accountWorkspace: "gtm",
      },
    });
    // The LinkedIn sequence starts: first message once the invite is accepted.
    expect(enrollments[0]).toMatchObject({
      prospectId: 42,
      playName: "luma-events",
      channel: "linkedin",
    });
  });

  it("turns a refusal the founder can fix into a flag, and records nothing", async () => {
    const err = Object.assign(new Error("job failed"), { code: "email_required" });
    const { sender: s } = sender(err);
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" });
    expect(out).toEqual({ sent: false, flags: ["linkedin-email-required"] });
    expect(events).toHaveLength(0);
  });

  it("defers the batch when the account's daily invites are used up", async () => {
    const { sender: s } = sender(new Error("job failed: account_send_limit"));
    const err = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: s,
      workspace: "gtm",
    }).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
  });

  it("refuses a row with no LinkedIn profile without calling OneShot", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ linkedinUrl: undefined }),
      note: "hi",
      sender: s,
      workspace: "gtm",
    });
    expect(out.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never sends an empty note or one over LinkedIn's limit", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const empty = await sendLinkedInInvite({ row: row(), note: "  ", sender: s, workspace: "gtm" });
    expect(empty).toEqual({ sent: false, flags: ["empty-note: write a note before sending"] });
    const long = await sendLinkedInInvite({
      row: row(),
      note: "x".repeat(301),
      sender: s,
      workspace: "gtm",
    });
    expect(long).toEqual({ sent: false, flags: ["note-too-long: 301/300 characters"] });
    expect(calls).toHaveLength(0);
  });

  it("throws on a result it doesn't understand", async () => {
    const { sender: s } = sender({ status: "weird" });
    await expect(
      sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" }),
    ).rejects.toThrow(/unexpected LinkedIn invite result/);
  });
});
