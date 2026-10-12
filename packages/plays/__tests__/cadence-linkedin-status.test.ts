import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { Ledger as LedgerType } from "@oneshot-gtm/core";

// LinkedIn acceptance from OneShot's invitation status, the first message to a
// connection with no conversation, the unattended status sweep, and the email
// capacity gate, all against a real ledger and a stubbed LinkedIn caller.

let ledger: LedgerType;
let dbPath: string;
let conversation: { conversationId: string; accountId: string; workspace: string } | null = null;
let emailCapacity = true;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    currentWorkspaceName: () => "gtm",
    loadConfig: () => ({ founderName: "Founder", productOneLiner: "a GTM workspace" }),
    linkedInConversationFor: () => conversation,
    linkedInOutreachAccount: () => ({ workspace: "gtm", accountId: "acct-1" }),
    hasAnySendCapacity: () => emailCapacity,
    listInbox: async () => ({ emails: [], has_more: false }),
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "prompt",
    complete: async () => ({ content: "Thanks for connecting — how is review going?" }),
  };
});

const { SendDeferredError } = await import("@oneshot-gtm/core");
const { Ledger } = await import("@oneshot-gtm/core");
const {
  enrollInCadence,
  runCadenceStepForProspect,
  previewCadenceStep,
  advanceCadence,
  sweepLinkedInInvitations,
} = await import("../src/index.ts");
await import("../src/repo-interest.ts");

const PLAY = "luma-events";
let prospectId: number;
let calls: Array<Record<string, unknown>>;

type Reply = (op: Record<string, unknown>) => unknown;
/** A stub LinkedIn caller: `reply` answers each operation by kind; calls are recorded. */
function caller(replies: Partial<Record<string, Reply>>) {
  return async (_workspace: string, op: unknown) => {
    const o = op as Record<string, unknown>;
    calls.push(o);
    const reply = replies[o.kind as string];
    if (!reply) throw new Error(`unexpected ${String(o.kind)}`);
    return reply(o);
  };
}
const kinds = () => calls.map((c) => c.kind);

function inviteSent(opts: { daysAgo?: number; inviteStatus?: string; prospect?: number } = {}) {
  const id = opts.prospect ?? prospectId;
  ledger.recordLinkedInInviteEvent({
    prospectId: id,
    playName: PLAY,
    stepIndex: 0,
    status: "sent",
    metadata: {
      note: "hello",
      body: "hello",
      invitationId: `inv-${id}`,
      accountId: "acct-1",
      accountWorkspace: "gtm",
      inviteStatus: opts.inviteStatus ?? "sent",
    },
  });
  const db = new Database(dbPath);
  db.exec(
    `UPDATE sequence_events SET created_at = datetime('now', '-${opts.daysAgo ?? 3} days') WHERE prospect_id = ${id}`,
  );
  db.close();
  enrollInCadence({ prospectId: id, playName: PLAY, channel: "linkedin" });
  makeDue(id);
}

function makeDue(id: number = prospectId): void {
  const db = new Database(dbPath);
  db.exec(
    `UPDATE cadence_state SET next_due_at = '2000-01-01T00:00:00.000Z' WHERE prospect_id = ${id}`,
  );
  db.close();
}

function inviteMeta(id: number = prospectId): Record<string, unknown> {
  const e = ledger.listLinkedInInviteEvents(id, PLAY).at(-1)!;
  return JSON.parse(e.metadata_json ?? "{}") as Record<string, unknown>;
}

const run = (linkedIn: ReturnType<typeof caller>, extra: Record<string, unknown> = {}) =>
  runCadenceStepForProspect({
    prospectId,
    playName: PLAY,
    dryRun: false,
    persistedPayload: { kind: "linkedin_message", text: "reviewed message" },
    linkedIn,
    ...extra,
  });

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-li-status-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  prospectId = ledger.upsertProspect({
    name: "Dana Lee",
    email: null,
    linkedin_url: "https://www.linkedin.com/in/dana-lee/?utm=1",
    source: PLAY,
  });
  conversation = null;
  emailCapacity = true;
  calls = [];
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("acceptance from invitation status", () => {
  it("accepted with no conversation: sends the first message with `message` and stores its conversation id", async () => {
    inviteSent();
    const li = caller({
      invitation: () => ({
        invitation_id: `inv-${prospectId}`,
        status: "accepted",
        accepted_at: "2026-10-01T09:00:00Z",
      }),
      message: () => ({ status: "sent", conversation_id: "conv-new" }),
    });
    const out = await run(li);
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["invitation", "message"]);
    expect(calls[1]).toMatchObject({
      kind: "message",
      accountId: "acct-1",
      profile: "https://www.linkedin.com/in/dana-lee",
      text: "reviewed message",
      idempotencyKey: `gtm:gtm:cadence:${prospectId}:${PLAY}:1`,
    });
    expect(inviteMeta()).toMatchObject({ acceptedAt: "2026-10-01T09:00:00Z" });
    const sent = ledger
      .listSequenceEventsForProspectPlay(prospectId, PLAY)
      .find((e) => e.step_index === 1)!;
    expect(JSON.parse(sent.metadata_json!)).toMatchObject({
      conversationId: "conv-new",
      accountId: "acct-1",
      accountWorkspace: "gtm",
    });
    expect(ledger.getCadence(prospectId, PLAY)!.current_step).toBe(1);
  });

  it("stores `now` as acceptedAt when the API's accepted_at is null", async () => {
    inviteSent();
    const before = Date.now();
    await run(
      caller({
        invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
        message: () => ({ status: "sent" }),
      }),
    );
    expect(Date.parse(inviteMeta().acceptedAt as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("a missing conversation_id in the result is left empty for the next inbox sync", async () => {
    inviteSent();
    await run(
      caller({
        invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
        message: () => ({ status: "sent" }),
      }),
    );
    const sent = ledger
      .listSequenceEventsForProspectPlay(prospectId, PLAY)
      .find((e) => e.step_index === 1)!;
    expect(JSON.parse(sent.metadata_json!)).not.toHaveProperty("conversationId");
  });

  it("the close goes into the conversation the first message created", async () => {
    inviteSent();
    await run(
      caller({
        invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
        message: () => ({ status: "sent", conversation_id: "conv-new" }),
      }),
    );
    makeDue();
    calls = [];
    const li = caller({ reply: () => ({ status: "sent" }) });
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: PLAY,
      dryRun: false,
      persistedPayload: { kind: "linkedin_message", text: "last note" },
      linkedIn: li,
    });
    expect(out.action).toBe("breakup");
    expect(calls[0]).toMatchObject({
      kind: "reply",
      conversationId: "conv-new",
      accountId: "acct-1",
      idempotencyKey: `gtm:gtm:cadence:${prospectId}:${PLAY}:2`,
    });
  });

  it("an invite that answered already_connected skips the wait and asks nothing", async () => {
    inviteSent({ inviteStatus: "already_connected" });
    const out = await run(caller({ message: () => ({ status: "sent", conversation_id: "c" }) }));
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["message"]);
  });

  it("not_connected and rate_limited defer: the step stays due and nothing is recorded", async () => {
    for (const code of ["not_connected", "rate_limited"]) {
      calls = [];
      inviteSent({ prospect: prospectId });
      const li = caller({
        invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
        message: () => {
          throw Object.assign(new Error("Tool request failed"), { code });
        },
      });
      const err = await run(li).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SendDeferredError);
      const cadence = ledger.getCadence(prospectId, PLAY)!;
      expect(cadence.current_step).toBe(0);
      expect(cadence.status).toBe("active");
      expect(cadence.last_send_error).toBeNull();
      expect(
        ledger
          .listSequenceEventsForProspectPlay(prospectId, PLAY)
          .filter((e) => e.step_index === 1),
      ).toEqual([]);
    }
  });

  it("any other send error is a failure, recorded on the cadence", async () => {
    inviteSent();
    const li = caller({
      invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
      message: () => {
        throw new Error("upstream exploded");
      },
    });
    await expect(run(li)).rejects.toThrow("upstream exploded");
    expect(ledger.getCadence(prospectId, PLAY)!.last_send_error).toContain("upstream exploded");
  });

  it("a retry sends the same idempotency key, so it cannot post twice", async () => {
    inviteSent();
    const li = caller({
      invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
      message: () => {
        throw Object.assign(new Error("slow"), { code: "rate_limited" });
      },
    });
    await run(li).catch(() => {});
    await run(li).catch(() => {});
    const keys = calls.filter((c) => c.kind === "message").map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("a step already sent is reconciled, not sent again", async () => {
    inviteSent();
    const li = caller({
      invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
      message: () => ({ status: "sent", conversation_id: "c" }),
    });
    await run(li);
    // Crash after the send but before the cadence advanced: roll the step back.
    const db = new Database(dbPath);
    db.exec(`UPDATE cadence_state SET current_step = 0 WHERE prospect_id = ${prospectId}`);
    db.close();
    makeDue();
    calls = [];
    const out = await run(li);
    expect(out.action).toBe("skipped");
    expect(kinds()).toEqual([]);
  });

  it("withdrawn completes the cadence and records the withdrawal", async () => {
    inviteSent();
    const out = await run(
      caller({
        invitation: () => ({ invitation_id: "i", status: "withdrawn", accepted_at: null }),
      }),
    );
    expect(out.action).toBe("completed");
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("stopped");
    expect(ledger.listLinkedInInviteEvents(prospectId, PLAY).map((e) => e.status)).toEqual([
      "sent",
      "withdrawn",
    ]);
  });

  it("declined_or_unknown waits inside the window", async () => {
    inviteSent({ daysAgo: 5 });
    const out = await run(
      caller({
        invitation: () => ({
          invitation_id: "i",
          status: "declined_or_unknown",
          accepted_at: null,
        }),
      }),
    );
    expect(out.action).toBe("waiting");
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("active");
    expect(kinds()).toEqual(["invitation"]);
  });

  it("declined_or_unknown completes at the timeout WITHOUT a withdraw call", async () => {
    inviteSent({ daysAgo: 22 });
    const out = await run(
      caller({
        invitation: () => ({
          invitation_id: "i",
          status: "declined_or_unknown",
          accepted_at: null,
        }),
      }),
    );
    expect(out.action).toBe("completed");
    expect(kinds()).toEqual(["invitation"]);
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("stopped");
    expect(ledger.listLinkedInInviteEvents(prospectId, PLAY).map((e) => e.status)).toEqual([
      "sent",
    ]);
  });

  it("pending at the timeout is withdrawn", async () => {
    inviteSent({ daysAgo: 22 });
    const out = await run(
      caller({
        invitation: () => ({ invitation_id: "i", status: "pending", accepted_at: null }),
        withdraw: () => ({ status: "withdrawn" }),
      }),
    );
    expect(out.action).toBe("completed");
    expect(kinds()).toEqual(["invitation", "withdraw"]);
  });

  it("not_sent records the invite as failed, so it never counts as an invite", async () => {
    inviteSent();
    const out = await run(
      caller({ invitation: () => ({ invitation_id: "i", status: "not_sent", accepted_at: null }) }),
    );
    expect(out.action).toBe("completed");
    const events = ledger.listLinkedInInviteEvents(prospectId, PLAY);
    expect(events.map((e) => e.status)).toEqual(["failed"]);
    expect(JSON.parse(events[0]!.metadata_json!)).toMatchObject({ failureReason: "not_sent" });
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("stopped");
  });

  it("a status call that errors falls back to the conversation check (none: waits)", async () => {
    inviteSent();
    const out = await run(
      caller({
        invitation: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out.action).toBe("waiting");
    expect(kinds()).toEqual(["invitation"]);
  });

  it("a status call that errors falls back to the conversation check (found: replies)", async () => {
    inviteSent();
    conversation = { conversationId: "conv-9", accountId: "acct-1", workspace: "gtm" };
    const out = await run(
      caller({
        invitation: () => {
          throw new Error("boom");
        },
        reply: () => ({ status: "sent" }),
      }),
    );
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["invitation", "reply"]);
  });

  it("an invite event with no invitationId falls back to the conversation check without a call", async () => {
    ledger.recordLinkedInInviteEvent({
      prospectId,
      playName: PLAY,
      stepIndex: 0,
      status: "sent",
      metadata: { note: "hello" },
    });
    enrollInCadence({ prospectId, playName: PLAY, channel: "linkedin" });
    makeDue();
    const out = await run(caller({}));
    expect(out.action).toBe("waiting");
    expect(calls).toEqual([]);
  });
});

describe("/cadences preview", () => {
  it("says it is waiting for acceptance since a date, instead of throwing a generic error", async () => {
    inviteSent({ daysAgo: 3 });
    await expect(previewCadenceStep({ prospectId, playName: PLAY })).rejects.toThrow(
      /^waiting for acceptance since \d{4}-\d{2}-\d{2}$/,
    );
  });

  it("drafts once the sweep has recorded the accept, with no conversation", async () => {
    inviteSent();
    const li = caller({
      invitations: () => ({
        invitations: [
          {
            invitation_id: `inv-${prospectId}`,
            status: "accepted",
            accepted_at: "2026-10-01T09:00:00Z",
          },
        ],
      }),
    });
    await sweepLinkedInInvitations({ linkedIn: li });
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    expect(preview).toMatchObject({ subject: "LinkedIn message", flags: [] });
  });
});

describe("unattended status sweep", () => {
  it("records an accept with acceptedAt and sends nothing", async () => {
    inviteSent();
    const li = caller({
      invitations: () => ({
        invitations: [
          {
            invitation_id: `inv-${prospectId}`,
            status: "accepted",
            accepted_at: "2026-10-01T09:00:00Z",
          },
        ],
      }),
    });
    const out = await sweepLinkedInInvitations({ linkedIn: li });
    expect(out).toMatchObject({ pending: 1, accepted: 1 });
    expect(kinds()).toEqual(["invitations"]);
    expect(inviteMeta()).toMatchObject({ acceptedAt: "2026-10-01T09:00:00Z" });
    // Nothing drafted or sent: the cadence is still on its first message.
    const cadence = ledger.getCadence(prospectId, PLAY)!;
    expect(cadence).toMatchObject({ status: "active", current_step: 0 });
    expect(cadence.next_step_draft_json).toBeNull();
    expect(
      ledger.listSequenceEventsForProspectPlay(prospectId, PLAY).filter((e) => e.step_index > 0),
    ).toEqual([]);
  });

  it("reads only what changed since the last good look", async () => {
    inviteSent();
    const seen: Array<unknown> = [];
    const li = caller({
      invitations: (op) => {
        seen.push(op.changedSince);
        return { invitations: [] };
      },
    });
    await sweepLinkedInInvitations({ linkedIn: li });
    await sweepLinkedInInvitations({ linkedIn: li });
    expect(seen[0]).toBeUndefined();
    expect(typeof seen[1]).toBe("string");
  });

  it("a failed list does not move the watermark", async () => {
    inviteSent();
    const bad = caller({
      invitations: () => {
        throw new Error("down");
      },
    });
    await sweepLinkedInInvitations({ linkedIn: bad });
    expect(ledger.getPollWatermark(`linkedin.invitations.since:gtm:acct-1`)).toBeNull();
  });

  it("withdraws a 21-day-old pending invite, and sends no message", async () => {
    inviteSent({ daysAgo: 22 });
    const li = caller({
      invitations: () => ({ invitations: [] }),
      invitation: () => ({ invitation_id: "i", status: "pending", accepted_at: null }),
      withdraw: () => ({ status: "withdrawn" }),
    });
    const out = await sweepLinkedInInvitations({ linkedIn: li });
    expect(out).toMatchObject({ withdrawn: 1, stopped: 1 });
    expect(kinds()).toEqual(["invitations", "invitation", "withdraw"]);
    expect(kinds()).not.toContain("message");
    expect(kinds()).not.toContain("reply");
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("stopped");
    expect(ledger.listLinkedInInviteEvents(prospectId, PLAY).map((e) => e.status)).toEqual([
      "sent",
      "withdrawn",
    ]);
  });

  it("keeps an overdue invite that turns out to be accepted", async () => {
    inviteSent({ daysAgo: 30 });
    const li = caller({
      invitations: () => ({ invitations: [] }),
      invitation: () => ({ invitation_id: "i", status: "accepted", accepted_at: null }),
    });
    const out = await sweepLinkedInInvitations({ linkedIn: li });
    expect(out).toMatchObject({ accepted: 1, withdrawn: 0 });
    expect(kinds()).not.toContain("withdraw");
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("active");
  });

  it("does not withdraw an overdue invite OneShot calls declined_or_unknown", async () => {
    inviteSent({ daysAgo: 30 });
    const li = caller({
      invitations: () => ({ invitations: [] }),
      invitation: () => ({ invitation_id: "i", status: "declined_or_unknown", accepted_at: null }),
    });
    await sweepLinkedInInvitations({ linkedIn: li });
    expect(kinds()).not.toContain("withdraw");
  });

  it("leaves a fresh pending invite alone", async () => {
    inviteSent({ daysAgo: 4 });
    const li = caller({
      invitations: () => ({
        invitations: [{ invitation_id: `inv-${prospectId}`, status: "pending", accepted_at: null }],
      }),
    });
    const out = await sweepLinkedInInvitations({ linkedIn: li });
    expect(out).toMatchObject({ accepted: 0, stopped: 0 });
    expect(kinds()).toEqual(["invitations"]);
    expect(ledger.getCadence(prospectId, PLAY)!.status).toBe("active");
  });

  it("makes no API call when no invite is pending", async () => {
    const li = caller({});
    expect(await sweepLinkedInInvitations({ linkedIn: li })).toMatchObject({
      pending: 0,
      calls: 0,
    });
    // An accepted invite is not pending either.
    inviteSent({ inviteStatus: "already_connected" });
    expect(await sweepLinkedInInvitations({ linkedIn: li })).toMatchObject({ pending: 0 });
    expect(calls).toEqual([]);
  });

  it("asks once per account, however many invites it sent", async () => {
    inviteSent();
    const second = ledger.upsertProspect({
      name: "Sam Roe",
      email: null,
      linkedin_url: "https://www.linkedin.com/in/sam-roe",
      source: PLAY,
    });
    inviteSent({ prospect: second });
    const li = caller({ invitations: () => ({ invitations: [] }) });
    const out = await sweepLinkedInInvitations({ linkedIn: li });
    expect(out.pending).toBe(2);
    expect(kinds()).toEqual(["invitations"]);
  });
});

describe("email capacity", () => {
  it("still processes a due LinkedIn step when no email identity has capacity", async () => {
    emailCapacity = false;
    inviteSent();
    conversation = { conversationId: "conv-9", accountId: "acct-1", workspace: "gtm" };
    const li = caller({ reply: () => ({ status: "sent" }) });
    const result = await advanceCadence({ dryRun: false, linkedIn: li });
    expect(result.stepsExecuted).toBe(1);
    expect(kinds().filter((k) => k !== "invitation")).toEqual(["reply"]);
  });

  it("holds an email step in the same pass", async () => {
    emailCapacity = false;
    inviteSent();
    const emailer = ledger.upsertProspect({
      name: "Pat",
      email: "pat@example.com",
      source: PLAY,
    });
    enrollInCadence({ prospectId: emailer, playName: "repo-interest", channel: "email" });
    makeDue(emailer);
    conversation = { conversationId: "conv-9", accountId: "acct-1", workspace: "gtm" };
    const li = caller({ reply: () => ({ status: "sent" }) });
    const result = await advanceCadence({ dryRun: false, linkedIn: li });
    const held = result.details.find((d) => d.prospectEmail === "pat@example.com");
    expect(held).toMatchObject({ action: "skipped", note: "deferred: daily send caps reached" });
    expect(result.stepsExecuted).toBe(1);
  });
});
