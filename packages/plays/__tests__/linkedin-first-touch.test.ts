import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let modelNote = "Saw you hosted GTM in git — how are you handling review?";
const completeInputs: string[] = [];
const upserts: Array<Record<string, unknown>> = [];
const events: Array<Record<string, unknown>> = [];
const enrollments: Array<Record<string, unknown>> = [];
let failReceipt = false;

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
      recordLinkedInInviteEvent: (input: Record<string, unknown>) => {
        if (failReceipt) throw new Error("receipt store down");
        events.push(input);
        return 1;
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
const { isSendDeferred, _resetInviteLimitsCacheForTests } = await import("@oneshot-gtm/core");

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
  // A fresh shared DB per test: the guard refuses a profile that was already invited.
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "linkedin-first-touch-"));
  _resetInviteLimitsCacheForTests();
  modelNote = "Saw you hosted GTM in git — how are you handling review?";
  completeInputs.length = 0;
  upserts.length = 0;
  events.length = 0;
  enrollments.length = 0;
  failReceipt = false;
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
  it("refuses a person the guard rejects, sends nothing and leaves the profile free (#787)", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ name: "SWE-agent" }),
      note: "hi",
      sender: s,
      workspace: "gtm",
    });
    expect(out).toMatchObject({ sent: false, guard: "not-a-person" });
    expect((out as { flags: string[] }).flags[0]).toMatch(/^not-a-person:/);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
    // Fixing the row and resending works: the refusal reserved nothing.
    const fixed = await sendLinkedInInvite({
      row: row({ name: "Dana Lee" }),
      note: "hi",
      sender: s,
      workspace: "gtm",
    });
    expect(fixed).toMatchObject({ sent: true });
  });

  it("invites one profile once, across workspaces sharing the shared DB", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const first = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "one" });
    expect(first).toMatchObject({ sent: true });
    const second = await sendLinkedInInvite({
      row: row({ linkedinUrl: "https://de.linkedin.com/in/Dana-Lee/en" }),
      note: "hi",
      sender: s,
      workspace: "two",
    });
    expect(second).toMatchObject({ sent: false, guard: "already-invited" });
    expect(calls.filter((c) => (c as { kind: string }).kind === "invite")).toHaveLength(1);
  });

  it("refuses a profile on the suppression list", async () => {
    const { getSharedDb } = await import("@oneshot-gtm/core");
    getSharedDb().markLinkedInTouched({ slug: "dana-lee", source: "import:previous-tool" });
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" });
    expect(out).toMatchObject({ sent: false, guard: "already-touched" });
    expect(calls).toHaveLength(0);
  });

  it("frees the profile when the invite is deferred by the account cap", async () => {
    const capped = sender({});
    capped.sender.call = async (op: unknown) => {
      if ((op as { kind: string }).kind === "account") {
        return { limits: { invites: { limit: 25, remaining: 0, resets_at: null } } };
      }
      return {};
    };
    const err = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: capped.sender,
      workspace: "gtm",
    }).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
    _resetInviteLimitsCacheForTests();
    const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
    const retry = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" });
    expect(retry).toMatchObject({ sent: true });
  });

  it("sends the note, records the prospect and a step-0 LinkedIn event", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" });
    expect(out).toEqual({ sent: true, status: "sent", invitationId: "inv-1", prospectId: 42 });
    expect(calls.find((c) => (c as { kind: string }).kind === "invite")).toMatchObject({
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

  describe("an invite that may have gone out stays suppressed (#787)", () => {
    const again = async () => {
      const { sender: s, calls } = sender({ invitation_id: "inv-2", status: "sent" });
      const out = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: s,
        workspace: "two",
      });
      return { out, invites: calls.filter((c) => (c as { kind: string }).kind === "invite") };
    };

    it("an unexpected result keeps the profile held", async () => {
      const { sender: s } = sender({ status: "weird" });
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" }),
      ).rejects.toThrow();
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a transport error with no provider code (timeout, lost worker) keeps the profile held", async () => {
      const { sender: s } = sender(new Error("worker terminated"));
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" }),
      ).rejects.toThrow(/worker terminated/);
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a receipt-write failure after the provider accepted keeps the profile held", async () => {
      failReceipt = true;
      const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" }),
      ).rejects.toThrow(/receipt store down/);
      failReceipt = false;
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a failed confirmation does not free the profile", async () => {
      const { getSharedDb } = await import("@oneshot-gtm/core");
      const db = getSharedDb();
      const realConfirm = db.confirmLinkedInProfile.bind(db);
      db.confirmLinkedInProfile = () => {
        throw new Error("disk full");
      };
      try {
        const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
        const first = await sendLinkedInInvite({
          row: row(),
          note: "hi",
          sender: s,
          workspace: "gtm",
        });
        expect(first).toMatchObject({ sent: true });
      } finally {
        db.confirmLinkedInProfile = realConfirm;
      }
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it.each(["ECONNRESET", "ETIMEDOUT", "SQLITE_BUSY", "send_unverified", "unknown_code"])(
      "a coded error %s that does not prove non-delivery keeps the profile held",
      async (code) => {
        const { sender: s } = sender(Object.assign(new Error("failed"), { code }));
        await expect(
          sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" }),
        ).rejects.toThrow(/failed/);
        const { out, invites } = await again();
        expect(out).toMatchObject({ sent: false, guard: "already-invited" });
        expect(invites).toHaveLength(0);
      },
    );

    it("a coded failure while recording the receipt after provider success keeps the profile held", async () => {
      failReceipt = true;
      const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" }),
      ).rejects.toThrow();
      failReceipt = false;
      const { out } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
    });

    it("a provider-reported failure (job failed, no invite sent) frees the profile", async () => {
      const { sender: s } = sender(Object.assign(new Error("failed"), { code: "email_required" }));
      const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "gtm" });
      expect(out).toMatchObject({ sent: false });
      const retry = await again();
      expect(retry.out).toMatchObject({ sent: true });
    });
  });

  it("an X or GitHub URL is refused with the guard's invalid-profile reason", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ linkedinUrl: "https://github.com/dana-lee" }),
      note: "hi",
      sender: s,
      workspace: "gtm",
    });
    expect(out).toMatchObject({ sent: false, guard: "invalid-profile" });
    expect((out as { flags: string[] }).flags[0]).toMatch(/^invalid-profile:/);
    expect(calls).toHaveLength(0);
  });

  it("a row without any LinkedIn URL is also an invalid-profile refusal", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ linkedinUrl: undefined }),
      note: "hi",
      sender: s,
      workspace: "gtm",
    });
    expect(out).toMatchObject({ sent: false, guard: "invalid-profile" });
    expect(calls).toHaveLength(0);
  });
});
