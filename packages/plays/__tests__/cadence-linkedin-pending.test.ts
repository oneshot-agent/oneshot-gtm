import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { Ledger as LedgerType } from "@oneshot-gtm/core";

// A LinkedIn send OneShot paces (or refuses) after accepting it: the cadence
// polls the job, records a slow one once it is done, records one past the
// deadline as pending (never failed), and the sweep resolves pending sends
// from OneShot's records without sending anything. A refused invite frees the
// profile and skips the LinkedIn steps. Real ledger, stubbed LinkedIn caller.

let ledger: LedgerType;
let dbPath: string;
/** The 1:1 conversation the synced inbox holds with the prospect, if any. */
let conversation: { conversationId: string; accountId: string; workspace: string } | null = null;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    currentWorkspaceName: () => "alpha",
    loadConfig: () => ({
      founderName: "Founder",
      productOneLiner: "a GTM workspace",
      linkedinContinuation: true,
      linkedin: { writer: "model" },
    }),
    linkedInConversationFor: () => conversation,
    linkedInOutreachAccount: () => ({ workspace: "alpha", accountId: "acct-1" }),
    hasAnySendCapacity: () => true,
    listInbox: async () => ({ emails: [], has_more: false }),
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "prompt",
    complete: async () => ({ content: "Hi Dana, good to see you working on review." }),
  };
});

const { Ledger, getSharedDb, _resetInviteLimitsCacheForTests, _setLinkedInJobTimingForTests } =
  await import("@oneshot-gtm/core");
const { LINKEDIN_SEND_PENDING } = await import("@oneshot-gtm/shared-types");
const { enrollInCadence, runCadenceStepForProspect, sweepLinkedInInvitations } =
  await import("../src/index.ts");
await import("../src/repo-interest.ts"); // a one-step email sequence that continues on LinkedIn

const LI_PLAY = "luma-events";
const EMAIL_PLAY = "repo-interest";
let prospectId: number;
let calls: Array<Record<string, unknown>>;

type Reply = (op: Record<string, unknown>) => unknown;
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
/** The operations that put something on LinkedIn. */
const SENDS = new Set(["message", "invite", "reply", "withdraw"]);

const stillRunning = () => {
  throw Object.assign(new Error("Job timed out"), { name: "JobTimeoutError" });
};
const jobFailed = (code: string, partialResult?: Record<string, unknown>) => () => {
  throw Object.assign(new Error(`Job failed: ${code}`), {
    name: "JobError",
    code,
    jobError: code,
    ...(partialResult ? { partialResult } : {}),
  });
};
const accepted = (id = "job-1") => ({ status: "processing", request_id: id, tool: "linkedin" });
const accountOk = () => ({ limits: { invites: { limit: 25, remaining: 20, resets_at: null } } });

function sql(statement: string): void {
  const db = new Database(dbPath);
  db.exec(statement);
  db.close();
}

/** A LinkedIn cadence whose invite was accepted: the first message is due. */
function acceptedInvite(): void {
  ledger.recordLinkedInInviteEvent({
    prospectId,
    playName: LI_PLAY,
    stepIndex: 0,
    status: "sent",
    metadata: {
      note: "hello",
      body: "hello",
      invitationId: "inv-0",
      accountId: "acct-1",
      accountWorkspace: "alpha",
      inviteStatus: "sent",
      acceptedAt: "2026-10-01T09:00:00Z",
    },
  });
  sql(
    `UPDATE sequence_events SET created_at = datetime('now', '-3 days') WHERE prospect_id = ${prospectId}`,
  );
  enrollInCadence({ prospectId, playName: LI_PLAY, channel: "linkedin" });
  sql(
    `UPDATE cadence_state SET next_due_at = '2000-01-01T00:00:00.000Z' WHERE prospect_id = ${prospectId}`,
  );
}

const sendMessage = (linkedIn: ReturnType<typeof caller>) =>
  runCadenceStepForProspect({
    prospectId,
    playName: LI_PLAY,
    dryRun: false,
    persistedPayload: { kind: "linkedin_message", text: "reviewed message" },
    linkedIn,
  });
const MESSAGE_KEY = () => `gtm:alpha:cadence:${prospectId}:${LI_PLAY}:1`;
const liState = () => ledger.getCadence(prospectId, LI_PLAY)!;
const messageEvents = () =>
  ledger
    .listSequenceEventsForProspectPlay(prospectId, LI_PLAY)
    .filter((e) => e.step_index === 1 && e.status === "sent");

/** An email cadence that ran out and is parked on its connection-request step (step 2). */
function emailCadenceRunOut(): void {
  ledger.recordSequenceEvent({
    prospectId,
    playName: EMAIL_PLAY,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    metadata: { subject: "hello", body: "hello" },
  });
  enrollInCadence({ prospectId, playName: EMAIL_PLAY });
  ledger.advanceCadence({
    prospectId,
    playName: EMAIL_PLAY,
    newStep: 1,
    nextDueAt: "2000-01-01T00:00:00.000Z",
  });
}
const NOTE = "Hi Dana, good to see you working on review.";
const sendInvite = (linkedIn: ReturnType<typeof caller>) =>
  runCadenceStepForProspect({
    prospectId,
    playName: EMAIL_PLAY,
    dryRun: false,
    persistedPayload: { kind: "linkedin_invite", note: NOTE },
    linkedIn,
  });
const INVITE_KEY = () => `gtm:alpha:cadence:${prospectId}:${EMAIL_PLAY}:2:invite`;
const emailState = () => ledger.getCadence(prospectId, EMAIL_PLAY)!;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-li-pending-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "li-pending-"));
  _resetInviteLimitsCacheForTests();
  _setLinkedInJobTimingForTests({ pauseMs: 0 });
  prospectId = ledger.upsertProspect({
    name: "Dana Lee",
    email: "dana@example.com",
    linkedin_url: "https://www.linkedin.com/in/dana-lee",
    source: LI_PLAY,
  });
  calls = [];
  conversation = null;
});

afterEach(() => {
  _setLinkedInJobTimingForTests();
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("a LinkedIn message OneShot paces", () => {
  it("is recorded once its job finishes, after polls that found it still running", async () => {
    acceptedInvite();
    let polls = 0;
    const out = await sendMessage(
      caller({
        message: () => accepted(),
        wait: () => {
          if (++polls < 3) stillRunning();
          return { status: "sent", conversation_id: "conv-new", message_id: "m-1" };
        },
      }),
    );
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["message", "wait", "wait", "wait"]);
    expect(calls.filter((c) => c.kind === "wait").every((c) => c.requestId === "job-1")).toBe(true);
    expect(messageEvents()).toHaveLength(1);
    expect(JSON.parse(messageEvents()[0]!.metadata_json!)).toMatchObject({
      conversationId: "conv-new",
      accountWorkspace: "alpha",
    });
    expect(liState()).toMatchObject({ current_step: 1, last_send_error: null });
    expect(ledger.linkedInPending.list()).toEqual([]);
  });

  it("past the deadline is pending, never failed, and Send checks it instead of sending again", async () => {
    acceptedInvite();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const err = await sendMessage(caller({ message: () => accepted(), wait: stillRunning })).catch(
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("LinkedInSendPendingError");
    expect(liState()).toMatchObject({ current_step: 0, last_send_error: LINKEDIN_SEND_PENDING });
    expect(messageEvents()).toEqual([]);
    expect(ledger.linkedInPending.get(MESSAGE_KEY())).toMatchObject({
      kind: "message",
      requestId: "job-1",
      accountWorkspace: "alpha",
      stepIndex: 1,
      detail: { text: "reviewed message" },
    });
    // Clicked again: the job is checked, `message` is never called a second time.
    calls = [];
    const again = await sendMessage(
      caller({ wait: () => ({ status: "sent", conversation_id: "conv-new" }) }),
    );
    expect(again.action).toBe("step-sent");
    expect(kinds()).toEqual(["wait"]);
    expect(messageEvents()).toHaveLength(1);
    expect(ledger.linkedInPending.list()).toEqual([]);
  });
});

describe("a resumed send records what LinkedIn received", () => {
  it("a message: the text it was sent with, not a draft edited since", async () => {
    acceptedInvite();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendMessage(caller({ message: () => accepted(), wait: stillRunning })).catch(() => {});
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    await runCadenceStepForProspect({
      prospectId,
      playName: LI_PLAY,
      dryRun: false,
      persistedPayload: { kind: "linkedin_message", text: "edited since" },
      linkedIn: caller({ wait: () => ({ status: "sent", conversation_id: "conv-new" }) }),
    });
    expect(JSON.parse(messageEvents()[0]!.metadata_json!)).toMatchObject({
      body: "reviewed message",
    });
  });

  it("an invite: the note it was sent with, not a draft edited since", async () => {
    emailCadenceRunOut();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendInvite(
      caller({ account: accountOk, invite: () => accepted("job-inv"), wait: stillRunning }),
    ).catch(() => {});
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    calls = [];
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: EMAIL_PLAY,
      dryRun: false,
      persistedPayload: { kind: "linkedin_invite", note: "Hi Dana, edited since." },
      linkedIn: caller({
        account: accountOk,
        wait: () => ({ invitation_id: "inv-1", status: "sent" }),
      }),
    });
    expect(out.action).toBe("step-sent");
    expect(calls.some((c) => c.kind === "invite")).toBe(false);
    const invites = ledger.listLinkedInInviteEvents(prospectId, EMAIL_PLAY);
    expect(JSON.parse(invites.at(-1)!.metadata_json!)).toMatchObject({ note: NOTE, body: NOTE });
    // Resumed, not refused by its own claim: the cadence goes on to the message.
    expect(emailState()).toMatchObject({ status: "active", last_send_error: null });
  });
});

describe("a pending message whose conversation has since synced", () => {
  it("Send polls the stored job and never replies into that conversation", async () => {
    acceptedInvite();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendMessage(caller({ message: () => accepted(), wait: stillRunning })).catch(() => {});
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    // LinkedIn delivered it: the message's own conversation is now in the inbox.
    conversation = { conversationId: "conv-new", accountId: "acct-1", workspace: "alpha" };
    calls = [];
    const out = await sendMessage(
      caller({ wait: () => ({ status: "sent", conversation_id: "conv-new" }) }),
    );
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["wait"]);
    expect(calls[0]).toMatchObject({ requestId: "job-1" });
    expect(messageEvents()).toHaveLength(1);
    expect(ledger.linkedInPending.list()).toEqual([]);
  });
});

describe("the sweep resolves pending messages from OneShot's records", () => {
  async function pendingMessage(): Promise<void> {
    acceptedInvite();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendMessage(caller({ message: () => accepted(), wait: stillRunning })).catch(() => {});
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    calls = [];
  }

  it("a completed job is recorded as the send would have recorded it, and the cadence moves on", async () => {
    await pendingMessage();
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        recover: () => ({
          tool: "linkedin",
          status: "completed",
          linkedin: {
            action: "message",
            headroom: { used: 2, limit: 50, pending: 1 },
            account_id: "acct-1",
            scheduled_for: "2026-11-03T01:48:21.125Z",
          },
          receipt_id: "rcpt_1",
          request_id: "job-1",
        }),
        wait: () => ({ status: "sent", conversation_id: "conv-new", message_id: "m-1" }),
        invitations: () => ({ invitations: [] }),
        invitation: () => ({ status: "accepted" }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, sent: 1, failed: 0, pending: 0 });
    expect(calls[0]).toMatchObject({
      kind: "recover",
      endpoint: "linkedin/message",
      idempotencyKey: MESSAGE_KEY(),
    });
    expect(calls[1]).toMatchObject({ kind: "wait", requestId: "job-1" });
    expect(calls.some((c) => SENDS.has(c.kind as string))).toBe(false);
    expect(messageEvents()).toHaveLength(1);
    expect(JSON.parse(messageEvents()[0]!.metadata_json!)).toMatchObject({
      body: "reviewed message",
      conversationId: "conv-new",
      accountId: "acct-1",
    });
    expect(liState()).toMatchObject({ current_step: 1, last_send_error: null });
    expect(ledger.linkedInPending.list()).toEqual([]);
  });

  it("a failed job clears the pending marker and records the real error", async () => {
    await pendingMessage();
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        recover: () => ({ tool: "linkedin", status: "failed", request_id: "job-1" }),
        wait: jobFailed("recipient_unavailable"),
        invitations: () => ({ invitations: [] }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, failed: 1 });
    expect(calls.some((c) => SENDS.has(c.kind as string))).toBe(false);
    expect(messageEvents()).toEqual([]);
    expect(liState()).toMatchObject({
      current_step: 0,
      last_send_error: "LinkedIn message not sent (recipient_unavailable)",
    });
    expect(ledger.linkedInPending.list()).toEqual([]);
  });

  it("a key OneShot does not know, or a job still running, stays pending", async () => {
    await pendingMessage();
    for (const answer of [
      { status: "unknown", acceptance: "unknown" },
      { tool: "linkedin", status: "processing", request_id: "job-1" },
    ]) {
      const out = await sweepLinkedInInvitations({
        linkedIn: caller({ recover: () => answer, invitations: () => ({ invitations: [] }) }),
      });
      expect(out.pendingSends).toMatchObject({ checked: 1, pending: 1 });
    }
    expect(kinds().filter((k) => k !== "recover" && k !== "invitations")).toEqual([]);
    expect(liState().last_send_error).toBe(LINKEDIN_SEND_PENDING);
    expect(ledger.linkedInPending.get(MESSAGE_KEY())!.checks).toBe(2);
  });
});

describe("an invite LinkedIn refused frees the profile", () => {
  const refused = () =>
    caller({
      account: accountOk,
      invite: () => accepted("job-inv"),
      wait: jobFailed("content_rejected", { invitation_id: "inv-x" }),
      invitation: () => ({ invitation_id: "inv-x", status: "not_sent", profile: "dana-lee" }),
    });

  it("content_rejected with a not_sent invitation: claim released, flagged, LinkedIn steps skipped", async () => {
    emailCadenceRunOut();
    const out = await sendInvite(refused());
    expect(out.action).toBe("completed");
    expect(out.note).toContain(
      "linkedin-invite-refused: LinkedIn refused this invite (content_rejected)",
    );
    expect(calls.find((c) => c.kind === "invitation")).toMatchObject({ invitationId: "inv-x" });
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    expect(emailState().status).toBe("completed");
    const skipped = ledger
      .listSequenceEventsForProspectPlay(prospectId, EMAIL_PLAY)
      .filter((e) => e.channel === "linkedin");
    expect(skipped.map((e) => [e.step_index, e.status])).toEqual([[2, "skipped"]]);
    expect(ledger.listLinkedInInviteEvents(prospectId, EMAIL_PLAY)).toEqual([]);
  });

  it("a failure without that proof keeps the claim", async () => {
    emailCadenceRunOut();
    const err = await sendInvite(
      caller({
        account: accountOk,
        invite: () => accepted("job-inv"),
        wait: jobFailed("content_rejected", { invitation_id: "inv-x" }),
        // The invitation may have gone out: no proof.
        invitation: () => ({ invitation_id: "inv-x", status: "pending" }),
      }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("JobError");
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
    expect(emailState()).toMatchObject({ status: "active", current_step: 1 });
  });

  it("a pending invite the sweep finds refused is freed and its steps skipped, without inviting", async () => {
    emailCadenceRunOut();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const err = await sendInvite(
      caller({ account: accountOk, invite: () => accepted("job-inv"), wait: stillRunning }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("LinkedInSendPendingError");
    expect(emailState().last_send_error).toBe(LINKEDIN_SEND_PENDING);
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
    expect(ledger.linkedInPending.get(INVITE_KEY())).toMatchObject({ kind: "invite" });
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    calls = [];
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        recover: () => ({
          tool: "linkedin",
          status: "failed",
          linkedin: { action: "invite", invitation_id: "inv-x" },
          request_id: "job-inv",
        }),
        wait: jobFailed("content_rejected", { invitation_id: "inv-x" }),
        invitation: () => ({ invitation_id: "inv-x", status: "not_sent" }),
        invitations: () => ({ invitations: [] }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, refused: 1 });
    expect(calls.some((c) => SENDS.has(c.kind as string))).toBe(false);
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    expect(emailState().status).toBe("completed");
    expect(ledger.linkedInPending.list()).toEqual([]);
  });

  it("a pending invite the sweep finds sent is recorded, the claim confirmed and the cadence moved on", async () => {
    emailCadenceRunOut();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendInvite(
      caller({ account: accountOk, invite: () => accepted("job-inv"), wait: stillRunning }),
    ).catch(() => {});
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    calls = [];
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        recover: () => ({ tool: "linkedin", status: "completed", request_id: "job-inv" }),
        wait: () => ({ invitation_id: "inv-1", status: "sent" }),
        invitations: () => ({ invitations: [] }),
        invitation: () => ({ invitation_id: "inv-1", status: "pending" }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, sent: 1 });
    expect(calls.some((c) => SENDS.has(c.kind as string))).toBe(false);
    const invites = ledger.listLinkedInInviteEvents(prospectId, EMAIL_PLAY);
    expect(invites.map((e) => [e.step_index, e.status])).toEqual([[2, "sent"]]);
    expect(JSON.parse(invites[0]!.metadata_json!)).toMatchObject({
      invitationId: "inv-1",
      note: NOTE,
    });
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("confirmed");
    expect(emailState()).toMatchObject({
      status: "active",
      current_step: 2,
      last_send_error: null,
    });
  });
});
