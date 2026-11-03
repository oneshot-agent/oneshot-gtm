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
// Pending sends, by idempotency key (the ledger's linkedInPending store).
const pendingSends = new Map<string, Record<string, unknown>>();
// Failed attempts per base key (the ledger's linkedInSendAttempts store).
const sendAttempts = new Map<string, number>();
// The prompt tests pin the model writer; the template tests set their own.
let linkedinCfg: Record<string, unknown> = { writer: "model" };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      founderName: "Founder",
      productOneLiner: "a GTM workspace",
      linkedin: linkedinCfg,
    }),
    logEvent: () => {},
    getLedger: () => ({
      upsertProspect: (input: Record<string, unknown>) => {
        upserts.push(input);
        return 42;
      },
      inTransaction: <T>(fn: () => T): T => fn(),
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
      linkedInPending: {
        get: (key: string) => pendingSends.get(key) ?? null,
        record: (input: Record<string, unknown>) => {
          pendingSends.set(input["idempotencyKey"] as string, input);
        },
        clear: (key: string) => {
          pendingSends.delete(key);
        },
      },
      linkedInSendAttempts: {
        key: (base: string) => actual.linkedInSendKeyAt(base, sendAttempts.get(base) ?? 0),
        noteFailed: (key: string, err: unknown) => {
          if (!actual.isFailedLinkedInSend(err)) return false;
          const base = actual.linkedInSendBaseKey(key);
          const attempt = sendAttempts.get(base) ?? 0;
          if (actual.linkedInSendKeyAt(base, attempt) !== key) return false;
          sendAttempts.set(base, attempt + 1);
          return true;
        },
      },
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

const { draftLinkedInNote, recordKnownConnection, sendLinkedInInvite } =
  await import("../src/_linkedin-first-touch.ts");
const { getSharedDb, isSendDeferred, _resetInviteLimitsCacheForTests } =
  await import("@oneshot-gtm/core");

const today = () => new Date().toISOString().slice(0, 10);
/** Invite slots the workspace holds on the account today. */
const slots = () => getSharedDb().inviteSlotsUsed("acct-1", "alpha", today());
/** The idempotency keys the invite calls went under. */
const inviteKeys = (calls: unknown[]) =>
  calls
    .filter((c) => (c as { kind: string }).kind === "invite")
    .map((c) => (c as { idempotencyKey: string }).idempotencyKey);

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
      workspace: "alpha",
      call: async (op: unknown) => {
        calls.push(op);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

/** An invite whose job fails `content_rejected`; the invitation reads `invitationStatus`. */
const rejected = (invitationStatus: string | Error) => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    sender: {
      accountId: "acct-1",
      workspace: "alpha",
      call: async (op: unknown) => {
        const o = op as Record<string, unknown>;
        calls.push(o);
        if (o["kind"] === "account") return {};
        if (o["kind"] === "invite") return { status: "processing", request_id: "job-1" };
        if (o["kind"] === "invitation") {
          if (invitationStatus instanceof Error) throw invitationStatus;
          return { invitation_id: "inv-x", status: invitationStatus };
        }
        throw Object.assign(new Error("Job failed: content_rejected"), {
          name: "JobError",
          code: "content_rejected",
          jobError: "content_rejected",
          partialResult: { invitation_id: "inv-x" },
        });
      },
    },
  };
};

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
  pendingSends.clear();
  sendAttempts.clear();
  linkedinCfg = { writer: "model" };
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

  it("reports whether the prompt carried an evidence clause (#792)", async () => {
    const withClause = await draftLinkedInNote(row({ repo: "acme/widgets" }));
    expect(completeInputs.at(-1)).toContain("EVIDENCE_CLAUSE: starred acme/widgets");
    expect(withClause.evidenceClause).toBe(true);
    const without = await draftLinkedInNote(row());
    expect(completeInputs.at(-1)).not.toContain("EVIDENCE_CLAUSE");
    expect(without.evidenceClause).toBe(false);
  });

  it("holds a note that puts the founder in the reader's batch, after one repair turn", async () => {
    modelNote = "Hey Dana, in YC F26 as well. How are you handling review?";
    const note = await draftLinkedInNote(row());
    expect(completeInputs).toHaveLength(2);
    expect(completeInputs[0]).not.toContain("SENDER_COHORT");
    expect(note.flags).toEqual(
      expect.arrayContaining([expect.stringMatching(/^shared-cohort: "in it too"/)]),
    );
  });

  it("with templates, fills the note from the row's evidence and calls no model", async () => {
    linkedinCfg = {};
    const note = await draftLinkedInNote(row({ repo: "acme/widgets" }));
    expect(note.body).toBe("Hi Dana, saw you starred acme/widgets. Would be good to connect.");
    expect(note).toMatchObject({ flags: [], voiceKey: null, evidenceClause: true });
    expect(completeInputs).toEqual([]);
  });

  it("with templates, a row with no evidence gets the fallback and the usual flags", async () => {
    linkedinCfg = { templates: { noteFallback: "hey {first_name}, would be good to connect." } };
    const note = await draftLinkedInNote(row({ linkedinUrl: "https://acme.com" }));
    expect(note.body).toBe("hey Dana, would be good to connect.");
    expect(note.evidenceClause).toBe(false);
    expect(note.flags).toEqual(["no-linkedin: this row has no LinkedIn profile URL"]);
  });
});

describe("sendLinkedInInvite", () => {
  it("refuses a person the guard rejects, sends nothing and leaves the profile free (#787)", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ name: "SWE-agent" }),
      note: "hi",
      sender: s,
      workspace: "alpha",
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
      workspace: "alpha",
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
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" });
    expect(out).toMatchObject({ sent: false, guard: "already-touched" });
    expect(calls).toHaveLength(0);
  });

  it("refuses someone the account already has a conversation with, and sends nothing", async () => {
    const { getLinkedInInboxStore } = await import("@oneshot-gtm/core");
    // Its own profile: the inbox store is one per process, so this thread
    // must not match the row the other tests invite.
    const store = getLinkedInInboxStore();
    store.saveConversation(
      "acct-key",
      {
        id: "chat-erin",
        attendees: [
          { provider_id: "ACo-self", profile_url: null, is_self: true },
          {
            provider_id: "ACo-erin",
            profile_url: "https://www.linkedin.com/in/erin-park",
            is_self: false,
          },
        ],
        attendees_synced: true,
      } as never,
      [],
    );
    store.saveMessages("acct-key", [
      {
        id: "m1",
        conversation_id: "chat-erin",
        direction: "outbound",
        sender_provider_id: "ACo-self",
        sender_name: "Me",
        text: "good to see you last week",
        sent_at: "2026-01-01T00:00:00Z",
        deleted: false,
      } as never,
    ]);
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ name: "Erin Park", linkedinUrl: "https://www.linkedin.com/in/erin-park/" }),
      note: "hi",
      sender: s,
      workspace: "alpha",
    });
    expect(out).toMatchObject({ sent: false, guard: "already-in-conversation" });
    expect(calls).toHaveLength(0);
    // Nothing was claimed: the profile is not marked as invited.
    const { getSharedDb } = await import("@oneshot-gtm/core");
    expect(getSharedDb().linkedInTouch("erin-park")).toBeNull();
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
      workspace: "alpha",
    }).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
    _resetInviteLimitsCacheForTests();
    const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
    const retry = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: s,
      workspace: "alpha",
    });
    expect(retry).toMatchObject({ sent: true });
  });

  it("sends the note, records the prospect and a step-0 LinkedIn event", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" });
    expect(out).toEqual({ sent: true, status: "sent", invitationId: "inv-1", prospectId: 42 });
    expect(calls.find((c) => (c as { kind: string }).kind === "invite")).toMatchObject({
      kind: "invite",
      accountId: "acct-1",
      profile: "https://www.linkedin.com/in/dana-lee",
      note: "hi",
      idempotencyKey: "gtm:alpha:queue:7:invite",
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
        accountWorkspace: "alpha",
      },
    });
    // The LinkedIn sequence starts: first message once the invite is accepted.
    // It links the row; the row has no offer, so the sequence has none yet.
    expect(enrollments[0]).toMatchObject({
      prospectId: 42,
      playName: "luma-events",
      channel: "linkedin",
      queueId: 7,
    });
    expect(enrollments[0]!["offer"]).toBeUndefined();
  });

  it("starts the sequence with the row's offer, which its messages make (the note never does)", async () => {
    const offer = { offer: "get every event follow-up sent the same day", steps: "drafts them" };
    const candidates = [offer, { offer: "get every host thanked", steps: "writes it" }];
    const { sender: s } = sender({ invitation_id: "inv-2", status: "sent" });
    await sendLinkedInInvite({
      row: row({ offer, offerCandidates: candidates }),
      note: "hi",
      sender: s,
      workspace: "alpha",
    });
    expect(enrollments[0]).toMatchObject({
      queueId: 7,
      offer: { offer, candidates, origin: "derived" },
    });
  });

  it("records whether the note carried an evidence clause on the invite event (#792)", async () => {
    const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
    await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: s,
      workspace: "alpha",
      evidenceClause: true,
    });
    expect(events.at(-1)!["metadata"]).toMatchObject({ evidenceClause: true });
    await sendLinkedInInvite({
      row: row({ linkedinUrl: "https://www.linkedin.com/in/other-person", name: "Other Person" }),
      note: "hi",
      sender: s,
      workspace: "alpha",
      evidenceClause: false,
    });
    expect(events.at(-1)!["metadata"]).toMatchObject({ evidenceClause: false });
  });

  it("records nothing about the clause when the caller does not know (#792)", async () => {
    const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
    await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" });
    expect(events.at(-1)!["metadata"]).not.toHaveProperty("evidenceClause");
  });

  it("turns a refusal the founder can fix into a flag, and records nothing", async () => {
    const err = Object.assign(new Error("job failed"), { code: "email_required" });
    const { sender: s } = sender(err);
    const out = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" });
    expect(out).toEqual({ sent: false, flags: ["linkedin-email-required"] });
    expect(events).toHaveLength(0);
  });

  it("a note fixed after a failed invite job goes out under a new key", async () => {
    const failed = Object.assign(new Error("Job failed: note_too_long"), {
      name: "JobError",
      code: "note_too_long",
      jobError: "note_too_long",
    });
    const first = sender(failed);
    expect(
      await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: first.sender,
        workspace: "alpha",
      }),
    ).toEqual({ sent: false, flags: ["linkedin-note-too-long"] });
    // OneShot would replay the failed job under the old key, old note and all.
    const again = sender({ invitation_id: "inv-1", status: "sent" });
    expect(
      await sendLinkedInInvite({
        row: row(),
        note: "hi again",
        sender: again.sender,
        workspace: "alpha",
      }),
    ).toMatchObject({ sent: true });
    expect(again.calls.find((c) => (c as { kind: string }).kind === "invite")).toMatchObject({
      note: "hi again",
      idempotencyKey: "gtm:alpha:queue:7:invite:r1",
    });
  });

  it("an invite that may have gone out (send_unverified) keeps its key", async () => {
    const unverified = Object.assign(new Error("Job failed: send_unverified"), {
      name: "JobError",
      code: "send_unverified",
    });
    await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: sender(unverified).sender,
      workspace: "alpha",
    }).catch(() => {});
    expect(sendAttempts.get("gtm:alpha:queue:7:invite")).toBeUndefined();
  });

  it("recipient_unavailable is refused without an invitation lookup, LinkedIn's reason in the flag", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const out = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      workspace: "alpha",
      sender: {
        accountId: "acct-1",
        workspace: "alpha",
        call: async (op: unknown) => {
          const o = op as Record<string, unknown>;
          calls.push(o);
          if (o["kind"] === "account") return {};
          if (o["kind"] === "invite") return { status: "processing", request_id: "job-1" };
          throw Object.assign(new Error("Job failed: recipient_unavailable"), {
            name: "JobError",
            code: "recipient_unavailable",
            upstreamReason: "invalid_recipient",
            partialResult: { invitation_id: "inv-x" },
          });
        },
      },
    });
    expect(out).toEqual({
      sent: false,
      flags: [
        "linkedin-invite-refused: LinkedIn refused this invite (recipient_unavailable: invalid_recipient)",
      ],
      guard: "linkedin-invite-refused",
    });
    expect(calls.map((c) => c["kind"])).not.toContain("invitation");
    expect(events).toHaveLength(0);
    // Freed: the profile can be invited again.
    expect(
      await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: sender({ invitation_id: "inv-2", status: "sent" }).sender,
        workspace: "alpha",
      }),
    ).toMatchObject({ sent: true });
  });

  it("defers the batch when the account's daily invites are used up", async () => {
    const { sender: s } = sender(new Error("job failed: account_send_limit"));
    const err = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: s,
      workspace: "alpha",
    }).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
  });

  it("a code decides: a cap named only in a failed job's text does not override it", async () => {
    // OneShot's `jobError` is a sentence; the code says what failed.
    const capped = sender(
      Object.assign(new Error("job failed"), {
        name: "JobError",
        code: "job_failed",
        jobError: "Paused: account_send_limit was mentioned, but this is another failure.",
      }),
    );
    const out = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: capped.sender,
      workspace: "alpha",
    }).catch((e: unknown) => e);
    expect(isSendDeferred(out)).toBe(false);
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
  });

  it("the older format (a failed job whose jobError is the code) still frees the profile", async () => {
    const capped = sender(
      Object.assign(new Error("job failed"), { name: "JobError", jobError: "account_send_limit" }),
    );
    const out = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: capped.sender,
      workspace: "alpha",
    }).catch((e) => e);
    expect(isSendDeferred(out)).toBe(true);
    // The profile was freed: the next attempt sends.
    _resetInviteLimitsCacheForTests();
    const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
    const retry = await sendLinkedInInvite({
      row: row(),
      note: "hi",
      sender: s,
      workspace: "alpha",
    });
    expect(retry).toMatchObject({ sent: true });
  });

  describe("an invite answered by a cap", () => {
    it("a synchronous 429 may have gone out: claim and slot kept, same key, invites paused", async () => {
      const limited = sender(
        Object.assign(new Error("Tool request failed: rate_limited"), {
          name: "ToolError",
          statusCode: 429,
          code: "rate_limited",
        }),
      );
      const err = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: limited.sender,
        workspace: "alpha",
      }).catch((e: unknown) => e);
      expect(isSendDeferred(err)).toBe(true);
      expect((err as Error).message).toBe("LinkedIn invites paused for today (rate_limited)");
      expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
      expect(slots()).toBe(1);
      expect(sendAttempts.size).toBe(0);
      // Kept under its key with no job id: the sweep never sends it.
      expect(pendingSends.get("gtm:alpha:queue:7:invite")).toMatchObject({ requestId: "" });
      const sweep = sender({ invitation_id: "inv-1", status: "sent" });
      expect(
        await sendLinkedInInvite({
          row: row(),
          note: "hi",
          sender: sweep.sender,
          workspace: "alpha",
          resumeOnly: true,
        }),
      ).toMatchObject({ sent: false });
      expect(inviteKeys(sweep.calls)).toEqual([]);
      // Still paused today: Send again defers without calling invite.
      const sameDay = sender({ invitation_id: "inv-1", status: "sent" });
      const deferred = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: sameDay.sender,
        workspace: "alpha",
      }).catch((e: unknown) => e);
      expect(isSendDeferred(deferred)).toBe(true);
      expect(inviteKeys(sameDay.calls)).toEqual([]);
      // The next day: its own claim does not refuse it, and it goes under the
      // same key, which OneShot answers with the first invite if it was made.
      _resetInviteLimitsCacheForTests();
      const next = sender({ invitation_id: "inv-1", status: "sent" });
      expect(
        await sendLinkedInInvite({
          row: row(),
          note: "hi",
          sender: next.sender,
          workspace: "alpha",
        }),
      ).toMatchObject({ sent: true });
      expect(inviteKeys(next.calls)).toEqual(["gtm:alpha:queue:7:invite"]);
      expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("confirmed");
      expect(slots()).toBe(1);
      expect(pendingSends.size).toBe(0);
    });

    const tooMany = () =>
      sender(Object.assign(new Error("Too Many Requests"), { name: "ToolError", statusCode: 429 }));

    it("the resend runs the guard again: opted out since the 429, nothing is sent", async () => {
      const mira = row({
        name: "Mira Okafor",
        linkedinUrl: "https://www.linkedin.com/in/mira-okafor",
      });
      await sendLinkedInInvite({
        row: mira,
        note: "hi",
        sender: tooMany().sender,
        workspace: "alpha",
      }).catch(() => {});
      expect(pendingSends.get("gtm:alpha:queue:7:invite")).toMatchObject({ requestId: "" });
      // They unsubscribed in the meantime (the guard reads the workspace's own ledger).
      const real = (
        await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")
      ).getLedger();
      const id = real.upsertProspect({
        name: "Mira Okafor",
        email: null,
        linkedin_url: "https://www.linkedin.com/in/mira-okafor",
        source: "luma-events",
      });
      real.enrollCadence({ prospectId: id, playName: "luma-events", nextDueAt: "2000-01-01" });
      real.setCadenceStatus({ prospectId: id, playName: "luma-events", status: "unsubscribed" });
      _resetInviteLimitsCacheForTests();
      const next = sender({ invitation_id: "inv-1", status: "sent" });
      const out = await sendLinkedInInvite({
        row: mira,
        note: "hi",
        sender: next.sender,
        workspace: "alpha",
      });
      expect(out).toEqual({
        sent: false,
        flags: ["opted-out: they opted out of contact"],
        guard: "opted-out",
      });
      expect(inviteKeys(next.calls)).toEqual([]);
      // The first invite may have gone out: the profile stays held, and the
      // resend is over.
      expect(getSharedDb().linkedInTouch("mira-okafor")?.status).toBe("dispatched");
      expect(pendingSends.size).toBe(0);
    });

    it("nothing changed since the 429: the resend passes its own claim and goes under the same key", async () => {
      await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: tooMany().sender,
        workspace: "alpha",
      }).catch(() => {});
      _resetInviteLimitsCacheForTests();
      const next = sender({ invitation_id: "inv-1", status: "sent" });
      expect(
        await sendLinkedInInvite({
          row: row(),
          note: "hi",
          sender: next.sender,
          workspace: "alpha",
        }),
      ).toMatchObject({ sent: true });
      expect(inviteKeys(next.calls)).toEqual(["gtm:alpha:queue:7:invite"]);
    });

    it("a 429 resend whose job fails with the cap gives the day's slot back", async () => {
      await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: tooMany().sender,
        workspace: "alpha",
      }).catch(() => {});
      expect(slots()).toBe(1);
      _resetInviteLimitsCacheForTests();
      const capped = sender(
        Object.assign(new Error("Job failed: account_send_limit"), {
          name: "JobError",
          code: "account_send_limit",
        }),
      );
      const err = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: capped.sender,
        workspace: "alpha",
      }).catch((e: unknown) => e);
      expect(isSendDeferred(err)).toBe(true);
      expect(slots()).toBe(0);
      expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
      expect(sendAttempts.get("gtm:alpha:queue:7:invite")).toBe(1);
    });

    it("a 429 is kept whatever its text says", async () => {
      const limited = tooMany();
      const err = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: limited.sender,
        workspace: "alpha",
      }).catch((e: unknown) => e);
      expect((err as Error).message).toBe("LinkedIn invites paused for today (429)");
      expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
    });

    it("a failed job with the cap proves nothing went out: claim and slot freed, the key moved on", async () => {
      const failed = sender(
        Object.assign(new Error("Job failed: This account reached today's invite limit."), {
          name: "JobError",
          code: "account_send_limit",
          jobError: "This account reached today's invite limit.",
          partialResult: { reason: "This account reached today's invite limit." },
        }),
      );
      const err = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: failed.sender,
        workspace: "alpha",
      }).catch((e: unknown) => e);
      expect((err as Error).message).toBe("LinkedIn invites paused for today (account_send_limit)");
      expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
      expect(slots()).toBe(0);
      expect(pendingSends.size).toBe(0);
      _resetInviteLimitsCacheForTests();
      const next = sender({ invitation_id: "inv-1", status: "sent" });
      await sendLinkedInInvite({ row: row(), note: "hi", sender: next.sender, workspace: "alpha" });
      expect(inviteKeys(next.calls)).toEqual(["gtm:alpha:queue:7:invite:r1"]);
    });
  });

  it("refuses a row with no LinkedIn profile without calling OneShot", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ linkedinUrl: undefined }),
      note: "hi",
      sender: s,
      workspace: "alpha",
    });
    expect(out.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never sends an empty note or one over LinkedIn's limit", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const empty = await sendLinkedInInvite({
      row: row(),
      note: "  ",
      sender: s,
      workspace: "alpha",
    });
    expect(empty).toEqual({ sent: false, flags: ["empty-note: write a note before sending"] });
    const long = await sendLinkedInInvite({
      row: row(),
      note: "x".repeat(301),
      sender: s,
      workspace: "alpha",
    });
    expect(long).toEqual({ sent: false, flags: ["note-too-long: 301/300 characters"] });
    expect(calls).toHaveLength(0);
  });

  it("throws on a result it doesn't understand", async () => {
    const { sender: s } = sender({ status: "weird" });
    await expect(
      sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
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
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
      ).rejects.toThrow();
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a transport error with no provider code (timeout, lost worker) keeps the profile held", async () => {
      const { sender: s } = sender(new Error("worker terminated"));
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
      ).rejects.toThrow(/worker terminated/);
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a receipt-write failure after the provider accepted keeps the profile held", async () => {
      failReceipt = true;
      const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
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
          workspace: "alpha",
        });
        expect(first).toMatchObject({ sent: true });
      } finally {
        db.confirmLinkedInProfile = realConfirm;
      }
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a transport code keeps the profile held even when its message names a provider code", async () => {
      const { sender: s } = sender(
        Object.assign(new Error("socket closed after rate_limited retry"), { code: "ECONNRESET" }),
      );
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
      ).rejects.toThrow(/socket closed/);
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it("a job error marked send_unverified keeps the profile held whatever else it says", async () => {
      const { sender: s } = sender(
        Object.assign(new Error("job failed"), {
          code: "job_failed",
          jobError: "send_unverified after rate_limited",
        }),
      );
      await expect(
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
      ).rejects.toThrow(/job failed/);
      const { out, invites } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
      expect(invites).toHaveLength(0);
    });

    it.each(["ECONNRESET", "ETIMEDOUT", "SQLITE_BUSY", "send_unverified", "unknown_code"])(
      "a coded error %s that does not prove non-delivery keeps the profile held",
      async (code) => {
        const { sender: s } = sender(Object.assign(new Error("failed"), { code }));
        await expect(
          sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
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
        sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" }),
      ).rejects.toThrow();
      failReceipt = false;
      const { out } = await again();
      expect(out).toMatchObject({ sent: false, guard: "already-invited" });
    });

    it("a provider-reported failure (job failed, no invite sent) frees the profile", async () => {
      const { sender: s } = sender(Object.assign(new Error("failed"), { code: "email_required" }));
      const out = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: s,
        workspace: "alpha",
      });
      expect(out).toMatchObject({ sent: false });
      const retry = await again();
      expect(retry.out).toMatchObject({ sent: true });
    });

    it("an invite LinkedIn refused (its invitation reads not_sent) frees the profile, with the refusal as a guard flag", async () => {
      const r = rejected("not_sent");
      const out = await sendLinkedInInvite({
        row: row(),
        note: "hi",
        sender: r.sender,
        workspace: "alpha",
      });
      expect(out).toEqual({
        sent: false,
        flags: ["linkedin-invite-refused: LinkedIn refused this invite (content_rejected)"],
        guard: "linkedin-invite-refused",
      });
      expect(r.calls.find((c) => c["kind"] === "invitation")).toMatchObject({
        accountId: "acct-1",
        invitationId: "inv-x",
      });
      expect(events).toHaveLength(0);
      const retry = await again();
      expect(retry.out).toMatchObject({ sent: true });
    });

    for (const [label, status] of [
      ["an invitation that reads pending", "pending"],
      ["an unreadable invitation", new Error("network")],
    ] as const) {
      it(`a refusal without proof (${label}) keeps the profile held`, async () => {
        const r = rejected(status);
        await expect(
          sendLinkedInInvite({ row: row(), note: "hi", sender: r.sender, workspace: "alpha" }),
        ).rejects.toThrow(/content_rejected/);
        const { out, invites } = await again();
        expect(out).toMatchObject({ sent: false, guard: "already-invited" });
        expect(invites).toHaveLength(0);
      });
    }
  });

  it("an X or GitHub URL is refused with the guard's invalid-profile reason", async () => {
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const out = await sendLinkedInInvite({
      row: row({ linkedinUrl: "https://github.com/dana-lee" }),
      note: "hi",
      sender: s,
      workspace: "alpha",
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
      workspace: "alpha",
    });
    expect(out).toMatchObject({ sent: false, guard: "invalid-profile" });
    expect(calls).toHaveLength(0);
  });
});

describe("recordKnownConnection", () => {
  const connection = { readAt: "2026-10-20T09:00:00.000Z" };
  const acct = { accountId: "acct-1", workspace: "alpha" };

  it("records the connection in place of an invite: no invite call, no slot, the profile claimed", async () => {
    const { getSharedDb } = await import("@oneshot-gtm/core");
    const out = recordKnownConnection({ row: row(), connection, sender: acct, workspace: "alpha" });
    expect(out).toEqual({ sent: true, status: "already_connected", prospectId: 42 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      prospectId: 42,
      stepIndex: 0,
      status: "sent",
      metadata: {
        subject: "LinkedIn: already connected",
        label: "already connected",
        inviteStatus: "already_connected",
        via: "profile-read",
        readAt: connection.readAt,
        accountId: "acct-1",
        accountWorkspace: "alpha",
      },
    });
    // Nothing was sent, so no note is recorded as one.
    expect((events[0]!["metadata"] as Record<string, unknown>)["note"]).toBeUndefined();
    expect(
      getSharedDb().inviteSlotsUsed("acct-1", "alpha", new Date().toISOString().slice(0, 10)),
    ).toBe(0);
    // Held like an invite: no other workspace starts on them.
    expect(getSharedDb().linkedInTouch("dana-lee")).toMatchObject({
      source: "connected:alpha",
      status: "confirmed",
    });
    const { sender: s, calls } = sender({ invitation_id: "inv-1", status: "sent" });
    const other = await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "two" });
    expect(other).toMatchObject({ sent: false, guard: "already-touched" });
    expect(calls).toHaveLength(0);
  });

  it("enrolls the LinkedIn sequence with its first message due now", () => {
    const before = Date.now();
    recordKnownConnection({ row: row(), connection, sender: acct, workspace: "alpha" });
    expect(enrollments[0]).toMatchObject({
      prospectId: 42,
      playName: "luma-events",
      channel: "linkedin",
      queueId: 7,
    });
    const due = Date.parse(String(enrollments[0]!["nextDueAt"]));
    expect(due).toBeGreaterThanOrEqual(before - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("as an email cadence's request step, records at that step for its prospect and enrolls nothing", () => {
    const out = recordKnownConnection({
      row: { ...row(), id: 0 },
      connection,
      sender: acct,
      workspace: "alpha",
      continuation: { prospectId: 9, stepIndex: 4 },
    });
    expect(out).toMatchObject({ sent: true, prospectId: 9 });
    expect(upserts).toHaveLength(0);
    expect(events[0]).toMatchObject({ prospectId: 9, stepIndex: 4 });
    expect(enrollments).toHaveLength(0);
  });

  it("passes the invite guard: an ICP reject, a non-person and a suppressed profile are refused", async () => {
    expect(
      recordKnownConnection({
        row: row({ icpVerdict: "reject" }),
        connection,
        sender: acct,
        workspace: "alpha",
      }),
    ).toMatchObject({ sent: false, guard: "icp-rejected" });
    expect(
      recordKnownConnection({
        row: row({ name: "SWE-agent" }),
        connection,
        sender: acct,
        workspace: "alpha",
      }),
    ).toMatchObject({ sent: false, guard: "not-a-person" });
    const { getSharedDb } = await import("@oneshot-gtm/core");
    getSharedDb().markLinkedInTouched({ slug: "dana-lee", source: "import:previous-tool" });
    expect(
      recordKnownConnection({ row: row(), connection, sender: acct, workspace: "alpha" }),
    ).toMatchObject({ sent: false, guard: "already-touched" });
    expect(events).toHaveLength(0);
    expect(enrollments).toHaveLength(0);
  });

  it("frees the claim when the record cannot be written", async () => {
    failReceipt = true;
    expect(() =>
      recordKnownConnection({ row: row(), connection, sender: acct, workspace: "alpha" }),
    ).toThrow("receipt store down");
    const { getSharedDb } = await import("@oneshot-gtm/core");
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
  });

  it("releaseKnownConnection frees only the connection's claim, never an invite's", async () => {
    const { getSharedDb, normalizeLinkedInProfile, releaseKnownConnection } =
      await import("@oneshot-gtm/core");
    recordKnownConnection({ row: row(), connection, sender: acct, workspace: "alpha" });
    const profile = normalizeLinkedInProfile("https://www.linkedin.com/in/dana-lee")!;
    expect(releaseKnownConnection({ profile, workspace: "alpha" })).toBe(true);
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    const { sender: s } = sender({ invitation_id: "inv-1", status: "sent" });
    await sendLinkedInInvite({ row: row(), note: "hi", sender: s, workspace: "alpha" });
    releaseKnownConnection({ profile, workspace: "alpha" });
    expect(getSharedDb().linkedInTouch("dana-lee")).toMatchObject({ source: "invite:alpha" });
  });
});
