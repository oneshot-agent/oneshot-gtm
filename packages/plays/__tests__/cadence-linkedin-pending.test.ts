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
/** Invite slots this workspace holds on the account today. */
const slotsToday = () =>
  getSharedDb().inviteSlotsUsed("acct-1", "alpha", new Date().toISOString().slice(0, 10));

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
    // Send again goes under a new key: OneShot answers the old one with the failure.
    expect(ledger.linkedInSendAttempts.key(MESSAGE_KEY())).toBe(`${MESSAGE_KEY()}:r1`);
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

  it("a pending invite whose job fails is given its slot back, the claim kept without proof", async () => {
    emailCadenceRunOut();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendInvite(
      caller({ account: accountOk, invite: () => accepted("job-inv"), wait: stillRunning }),
    ).catch(() => {});
    expect(slotsToday()).toBe(1);
    expect(ledger.linkedInPending.get(INVITE_KEY())!.detail["slotId"]).toEqual(expect.any(Number));
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        recover: () => ({ tool: "linkedin", status: "failed", request_id: "job-inv" }),
        wait: failedWith("internal_error"),
        invitations: () => ({ invitations: [] }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, failed: 1 });
    expect(slotsToday()).toBe(0);
    // No proof nothing went out: the profile stays held, as on a first send.
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
    expect(ledger.linkedInSendAttempts.key(INVITE_KEY())).toBe(`${INVITE_KEY()}:r1`);
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
    // Nothing went out: the day's slot it held is given back.
    expect(slotsToday()).toBe(0);
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
    // It went out: the slot stays spent, counted once.
    expect(slotsToday()).toBe(1);
  });
});

/** A failed job carrying OneShot's reason fields. */
const failedWith =
  (code: string, extra: Record<string, unknown> = {}) =>
  () => {
    throw Object.assign(new Error(`Job failed: ${code}`), {
      name: "JobError",
      code,
      jobError: code,
      ...extra,
    });
  };
/** OneShot's answer to a message or reply whose key already ran, as the SDK throws it. */
const duplicate = (requestId: string) => () => {
  throw Object.assign(new Error("Tool request failed"), {
    name: "ToolError",
    statusCode: 409,
    responseBody: JSON.stringify({
      error: "duplicate_request",
      message: "A request with this idempotency key already exists",
      details: { request_id: requestId },
    }),
  });
};
const sentKeys = (kind: string) =>
  calls.filter((c) => c.kind === kind).map((c) => c.idempotencyKey);

describe("a send whose job failed is sent again under a new key", () => {
  it("a failed message: Send again goes under :r1 and sends", async () => {
    acceptedInvite();
    const err = await sendMessage(
      caller({ message: () => accepted(), wait: failedWith("internal_error") }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("JobError");
    expect(liState().last_send_error).toMatch(/internal_error/);
    calls = [];
    const out = await sendMessage(
      caller({
        message: () => accepted("job-2"),
        wait: () => ({ status: "sent", conversation_id: "conv-new" }),
      }),
    );
    expect(out.action).toBe("step-sent");
    expect(sentKeys("message")).toEqual([`${MESSAGE_KEY()}:r1`]);
    expect(messageEvents()).toHaveLength(1);
  });

  it("an outcome that may have gone out keeps the key: send_unverified, a 429, pending", async () => {
    acceptedInvite();
    await sendMessage(
      caller({ message: () => accepted(), wait: failedWith("send_unverified") }),
    ).catch(() => {});
    await sendMessage(
      caller({
        message: () => {
          throw Object.assign(new Error("Tool request failed"), {
            name: "ToolError",
            statusCode: 429,
          });
        },
      }),
    ).catch(() => {});
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const err = await sendMessage(caller({ message: () => accepted(), wait: stillRunning })).catch(
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("LinkedInSendPendingError");
    expect(sentKeys("message")).toEqual([MESSAGE_KEY(), MESSAGE_KEY(), MESSAGE_KEY()]);
    expect(ledger.linkedInSendAttempts.key(MESSAGE_KEY())).toBe(MESSAGE_KEY());
    expect(ledger.linkedInPending.get(MESSAGE_KEY())).not.toBeNull();
  });

  it("a deferred message (rate_limited, recipient_not_connected) is retried under a new key each time", async () => {
    acceptedInvite();
    const first = await sendMessage(
      caller({ message: () => accepted(), wait: failedWith("rate_limited") }),
    ).catch((e: unknown) => e);
    expect((first as Error).name).toBe("SendDeferredError");
    // OneShot's new name for message's not_connected still waits for the acceptance.
    const second = await sendMessage(
      caller({ message: () => accepted(), wait: failedWith("recipient_not_connected") }),
    ).catch((e: unknown) => e);
    expect((second as Error).message).toBe("LinkedIn message deferred (not_connected)");
    expect(liState()).toMatchObject({ status: "active", current_step: 0 });
    const out = await sendMessage(
      caller({ message: () => accepted(), wait: () => ({ status: "sent" }) }),
    );
    expect(out.action).toBe("step-sent");
    expect(sentKeys("message")).toEqual([
      MESSAGE_KEY(),
      `${MESSAGE_KEY()}:r1`,
      `${MESSAGE_KEY()}:r2`,
    ]);
  });

  it("a deferred invite (rate_limited) is retried the next day under a new key", async () => {
    emailCadenceRunOut();
    const err = await sendInvite(
      caller({
        account: accountOk,
        invite: () => accepted("job-inv"),
        wait: failedWith("rate_limited"),
      }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("SendDeferredError");
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    // The next day: the account's limits are read again.
    _resetInviteLimitsCacheForTests();
    const out = await sendInvite(
      caller({
        account: accountOk,
        invite: () => accepted("job-inv-2"),
        wait: () => ({ invitation_id: "inv-1", status: "sent" }),
      }),
    );
    expect(out.action).toBe("step-sent");
    expect(sentKeys("invite")).toEqual([INVITE_KEY(), `${INVITE_KEY()}:r1`]);
    expect(ledger.listLinkedInInviteEvents(prospectId, EMAIL_PLAY)).toHaveLength(1);
  });
});

describe("a 409 duplicate_request: the key already ran", () => {
  it("its original job completed: recorded as sent, nothing sent again", async () => {
    acceptedInvite();
    const out = await sendMessage(
      caller({
        message: duplicate("job-orig"),
        wait: () => ({ status: "sent", conversation_id: "conv-orig" }),
      }),
    );
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["message", "wait"]);
    expect(calls[1]).toMatchObject({ requestId: "job-orig" });
    expect(JSON.parse(messageEvents()[0]!.metadata_json!)).toMatchObject({
      conversationId: "conv-orig",
    });
    expect(ledger.linkedInSendAttempts.key(MESSAGE_KEY())).toBe(MESSAGE_KEY());
  });

  it("its original job failed: the failure is shown, and the next click sends under :r1", async () => {
    acceptedInvite();
    const err = await sendMessage(
      caller({ message: duplicate("job-orig"), wait: failedWith("internal_error") }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("JobError");
    // One message call in the click: the original's failure is not retried there.
    expect(kinds()).toEqual(["message", "wait"]);
    expect(liState().last_send_error).toMatch(/internal_error/);
    calls = [];
    const out = await sendMessage(
      caller({ message: () => accepted("job-2"), wait: () => ({ status: "sent" }) }),
    );
    expect(out.action).toBe("step-sent");
    expect(sentKeys("message")).toEqual([`${MESSAGE_KEY()}:r1`]);
  });

  it("its original job still running: pending under the key", async () => {
    acceptedInvite();
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const err = await sendMessage(
      caller({ message: duplicate("job-orig"), wait: stillRunning }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("LinkedInSendPendingError");
    expect(ledger.linkedInPending.get(MESSAGE_KEY())).toMatchObject({ requestId: "job-orig" });
  });
});

describe("an invite to a recipient LinkedIn can't invite", () => {
  it("recipient_unavailable: refused without a lookup, the flag names LinkedIn's reason", async () => {
    emailCadenceRunOut();
    const out = await sendInvite(
      caller({
        account: accountOk,
        invite: () => accepted("job-inv"),
        wait: failedWith("recipient_unavailable", {
          reason: "recipient_unavailable",
          upstreamReason: "invalid_recipient",
        }),
      }),
    );
    expect(out.action).toBe("completed");
    expect(out.note).toContain(
      "linkedin-invite-refused: LinkedIn refused this invite (recipient_unavailable: invalid_recipient)",
    );
    expect(kinds()).not.toContain("invitation");
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    expect(emailState().status).toBe("completed");
    expect(ledger.listLinkedInInviteEvents(prospectId, EMAIL_PLAY)).toEqual([]);
  });
});

describe("a cadence reply into the conversation it already has", () => {
  const CONV = { conversationId: "conv-1", accountId: "acct-1", workspace: "alpha" };

  it("is polled: a failed job is not recorded, and Send again replies under :r1", async () => {
    acceptedInvite();
    conversation = CONV;
    const err = await sendMessage(
      caller({ reply: () => accepted("job-r"), wait: failedWith("internal_error") }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("JobError");
    expect(messageEvents()).toEqual([]);
    expect(liState()).toMatchObject({ current_step: 0 });
    const out = await sendMessage(
      caller({ reply: () => accepted("job-r2"), wait: () => ({ status: "sent" }) }),
    );
    expect(out.action).toBe("step-sent");
    expect(kinds().filter((k) => k === "message")).toEqual([]);
    expect(sentKeys("reply")).toEqual([MESSAGE_KEY(), `${MESSAGE_KEY()}:r1`]);
    expect(messageEvents()).toHaveLength(1);
  });

  it("past the deadline is pending, and the sweep records it from the job without replying", async () => {
    acceptedInvite();
    conversation = CONV;
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const err = await sendMessage(
      caller({ reply: () => accepted("job-r"), wait: stillRunning }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("LinkedInSendPendingError");
    expect(ledger.linkedInPending.get(MESSAGE_KEY())).toMatchObject({
      kind: "reply",
      requestId: "job-r",
    });
    expect(liState().last_send_error).toBe(LINKEDIN_SEND_PENDING);
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    calls = [];
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        wait: () => ({ status: "sent" }),
        invitations: () => ({ invitations: [] }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, sent: 1 });
    expect(calls[0]).toMatchObject({ kind: "wait", requestId: "job-r" });
    expect(calls.some((c) => SENDS.has(c.kind as string))).toBe(false);
    expect(messageEvents()).toHaveLength(1);
    expect(liState()).toMatchObject({ current_step: 1, last_send_error: null });
    expect(ledger.linkedInPending.list()).toEqual([]);
  });

  it("a pending reply the sweep finds failed records the error and moves the key on", async () => {
    acceptedInvite();
    conversation = CONV;
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    await sendMessage(caller({ reply: () => accepted("job-r"), wait: stillRunning })).catch(
      () => {},
    );
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    const out = await sweepLinkedInInvitations({
      linkedIn: caller({
        wait: failedWith("internal_error", { upstreamReason: "conversation_closed" }),
        invitations: () => ({ invitations: [] }),
      }),
    });
    expect(out.pendingSends).toMatchObject({ checked: 1, failed: 1 });
    expect(liState().last_send_error).toBe(
      "LinkedIn reply not sent (internal_error: conversation_closed)",
    );
    expect(ledger.linkedInSendAttempts.key(MESSAGE_KEY())).toBe(`${MESSAGE_KEY()}:r1`);
    expect(ledger.linkedInPending.list()).toEqual([]);
  });
});

describe("OneShot's failed-job format and a 429 on a cadence invite", () => {
  it("a failed job read from its code: the flag names LinkedIn's error type and OneShot's sentence", async () => {
    emailCadenceRunOut();
    const sentence = "This person can't be invited; LinkedIn rate limits do not apply.";
    const out = await sendInvite(
      caller({
        account: accountOk,
        invite: () => accepted("job-inv"),
        // `jobError` is the sentence, which mentions a rate limit: the code decides.
        wait: failedWith("recipient_unavailable", {
          jobError: sentence,
          partialResult: { reason: sentence, upstream_reason: "invalid_recipient" },
        }),
      }),
    );
    expect(out.action).toBe("completed");
    expect(out.note).toContain(
      `linkedin-invite-refused: LinkedIn refused this invite (recipient_unavailable: invalid_recipient): ${sentence}`,
    );
    expect(kinds()).not.toContain("invitation");
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
  });

  it("a 429 keeps the claim and defers; the next day's run sends under the same key", async () => {
    emailCadenceRunOut();
    const err = await sendInvite(
      caller({
        account: accountOk,
        invite: () => {
          throw Object.assign(new Error("Tool request failed"), {
            name: "ToolError",
            statusCode: 429,
          });
        },
      }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("SendDeferredError");
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("dispatched");
    expect(emailState()).toMatchObject({ status: "active", current_step: 1 });
    // The sweep finds no record under the key yet: left as it is, nothing sent.
    calls = [];
    const swept = await sweepLinkedInInvitations({
      linkedIn: caller({
        recover: () => ({ status: "unknown", acceptance: "unknown" }),
        invitations: () => ({ invitations: [] }),
      }),
    });
    expect(swept.pendingSends).toMatchObject({ checked: 1, pending: 1 });
    expect(calls.some((c) => SENDS.has(c.kind as string))).toBe(false);
    _resetInviteLimitsCacheForTests();
    calls = [];
    const out = await sendInvite(
      caller({
        account: accountOk,
        invite: () => accepted("job-inv"),
        wait: () => ({ invitation_id: "inv-1", status: "sent" }),
      }),
    );
    expect(out.action).toBe("step-sent");
    expect(sentKeys("invite")).toEqual([INVITE_KEY()]);
    expect(getSharedDb().linkedInTouch("dana-lee")?.status).toBe("confirmed");
    expect(ledger.linkedInPending.list()).toEqual([]);
  });
});
