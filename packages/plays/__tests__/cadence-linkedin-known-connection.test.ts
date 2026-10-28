import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { Ledger as LedgerType } from "@oneshot-gtm/core";

// Already connected, from a recent profile read: no connection request, the
// first message comes next. On an email cadence that carries on to LinkedIn
// and on a LinkedIn-first one. And when LinkedIn then says "not connected",
// the request is drafted at the same step and the message waits for it.
// Real ledger, stubbed LinkedIn caller.

let ledger: LedgerType;
let dbPath: string;
let linkedinCfg: Record<string, unknown> = { writer: "model" };
let noteText = "Hi Dana, good to see another person working on review. How is it going?";
const modelInputs: string[] = [];

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
      linkedin: linkedinCfg,
    }),
    linkedInConversationFor: () => null,
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
    complete: async (input: { messages: Array<{ content: string }> }) => {
      modelInputs.push(input.messages[1]!.content);
      return { content: noteText };
    },
  };
});

const { Ledger, getSharedDb, paidCacheKey, _resetPaidCache, _resetInviteLimitsCacheForTests } =
  await import("@oneshot-gtm/core");
const {
  enrollInCadence,
  previewCadenceStep,
  recordKnownConnection,
  runCadenceStepForProspect,
  sendCadenceStep,
  sweepLinkedInInvitations,
  _resetLinkedInLiveReads,
} = await import("../src/index.ts");
await import("../src/repo-interest.ts"); // registers a one-step email sequence

const PLAY = "repo-interest";
const PROFILE = "https://www.linkedin.com/in/dana-lee";
const DAY = 86_400_000;
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
const notConnected = () => {
  throw Object.assign(new Error("not connected"), { code: "not_connected" });
};

/** A person-research read of the profile, `ageDays` old, with this distance. */
function profileRead(networkDistance: string | null, ageDays = 2): void {
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  getSharedDb().setPaidCache({
    key: paidCacheKey("linkedin.profile_read", { url: PROFILE }),
    callType: "linkedin.profile_read",
    status: "ok",
    resultJson: JSON.stringify({ url: PROFILE, readAt: at, experience: [], networkDistance }),
    costUsd: 0.01,
    fetchedAt: at,
  });
}

function sql(statement: string): void {
  const db = new Database(dbPath);
  db.exec(statement);
  db.close();
}
const makeDue = () =>
  sql(
    `UPDATE cadence_state SET next_due_at = '2000-01-01T00:00:00.000Z' WHERE prospect_id = ${prospectId}`,
  );

/** The email intro went out and the cadence is parked on the connection-request step (step 2). */
function emailCadenceRunOut(): void {
  ledger.recordSequenceEvent({
    prospectId,
    playName: PLAY,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    metadata: { subject: "hello", body: "hello" },
  });
  enrollInCadence({ prospectId, playName: PLAY });
  ledger.advanceCadence({
    prospectId,
    playName: PLAY,
    newStep: 1,
    nextDueAt: "2000-01-01T00:00:00.000Z",
  });
}

async function shown() {
  const preview = await previewCadenceStep({ prospectId, playName: PLAY });
  if ("waiting" in preview || "skipped" in preview)
    throw new Error(`nothing to draft: ${JSON.stringify(preview)}`);
  return preview;
}
const send = (linkedIn: ReturnType<typeof caller>) =>
  sendCadenceStep({ prospectId, playName: PLAY, linkedIn });
const state = () => ledger.getCadence(prospectId, PLAY)!;
const inviteEvents = () =>
  ledger
    .listLinkedInInviteEvents(prospectId, PLAY)
    .map((e) => [e.step_index, e.status, JSON.parse(e.metadata_json ?? "{}")] as const);

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-li-known-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "li-known-"));
  _resetPaidCache();
  _resetInviteLimitsCacheForTests();
  _resetLinkedInLiveReads();
  linkedinCfg = { writer: "model" };
  noteText = "Hi Dana, good to see another person working on review. How is it going?";
  modelInputs.length = 0;
  calls = [];
  prospectId = ledger.upsertProspect({
    name: "Dana Lee",
    email: "dana@example.com",
    linkedin_url: PROFILE,
    source: PLAY,
  });
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

describe("an email cadence's connection-request step, for a known connection", () => {
  it("previews the skip without drafting, and Send next records it and makes message 1 due now", async () => {
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE");
    const preview = await shown();
    expect(preview.subject).toBe("LinkedIn: already connected");
    expect(preview.body).toMatch(
      /^Already connected: skipping the connection request \(profile read \d{4}-\d{2}-\d{2}\)\. The first message comes next\.$/,
    );
    expect(preview.flags).toEqual([]);
    expect(preview.payload).toMatchObject({ kind: "linkedin_connected" });
    expect(modelInputs).toEqual([]);

    const before = Date.now();
    const out = await send(caller({}));
    expect(out.action).toBe("step-sent");
    // No invite, no account read for an invite slot: nothing went to LinkedIn.
    expect(calls).toEqual([]);
    expect(inviteEvents()).toEqual([
      [
        2,
        "sent",
        expect.objectContaining({
          subject: "LinkedIn: already connected",
          via: "profile-read",
          inviteStatus: "already_connected",
          accountId: "acct-1",
          accountWorkspace: "alpha",
        }),
      ],
    ]);
    expect(state().current_step).toBe(2);
    expect(Date.parse(state().next_due_at!)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(state().next_due_at!)).toBeGreaterThanOrEqual(before - 1000);
    expect(ledger.getCadenceDraft({ prospectId, playName: PLAY })).toBeNull();
    expect(getSharedDb().linkedInTouch("dana-lee")).toMatchObject({ source: "connected:alpha" });

    // Message 1: nothing to wait for, written for someone already connected.
    const first = await shown();
    expect(first.payload.kind).toBe("linkedin_message");
    const input = modelInputs.at(-1)!;
    expect(input).toContain("ALREADY_CONNECTED:");
    expect(input).toContain("MESSAGE: first message on LinkedIn — you were already connected");
    // The record sent nothing, so it is no prior touch.
    expect(input).toContain("PRIOR TOUCHES:\n  (none recorded)");
    expect(input).not.toContain("profile read");
    const li = caller({ message: () => ({ status: "sent", conversation_id: "conv-1" }) });
    expect((await send(li)).action).toBe("step-sent");
    expect(calls).toEqual([
      expect.objectContaining({
        kind: "message",
        idempotencyKey: `gtm:alpha:cadence:${prospectId}:${PLAY}:3`,
      }),
    ]);
  });

  it("with templates, message 1 is the already-connected template", async () => {
    linkedinCfg = {
      templates: { firstMessageConnected: "hey {first_name}, so what are you building right now?" },
    };
    emailCadenceRunOut();
    profileRead("DISTANCE_1");
    await shown();
    await send(caller({}));
    expect((await shown()).body).toBe("hey Dana, so what are you building right now?");
    expect(modelInputs).toEqual([]);
  });

  it("drafts the connection request as before for a pending invitee", async () => {
    emailCadenceRunOut();
    profileRead("SECOND_DEGREE");
    expect((await shown()).payload.kind).toBe("linkedin_invite");
  });

  it("drafts the connection request as before for a first-degree read older than 14 days", async () => {
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE", 15);
    expect((await shown()).payload.kind).toBe("linkedin_invite");
  });

  it("drafts the connection request as before with no profile read at all", async () => {
    emailCadenceRunOut();
    expect((await shown()).payload.kind).toBe("linkedin_invite");
  });

  it("reads again at send: a read that no longer shows the connection records nothing", async () => {
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE");
    await shown();
    profileRead("SECOND_DEGREE", 0);
    const out = await send(caller({}));
    expect(out.action).toBe("skipped");
    expect(out.note).toMatch(/preview again to draft the connection request/);
    expect(inviteEvents()).toEqual([]);
    expect(state().current_step).toBe(1);
    expect(ledger.getCadenceDraft({ prospectId, playName: PLAY })).toBeNull();
    expect((await shown()).payload.kind).toBe("linkedin_invite");
  });

  it("the invite guard still decides first: a refused person gets no record", async () => {
    sql(`UPDATE prospects SET name = 'SWE-agent' WHERE id = ${prospectId}`);
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE");
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    expect(preview).toMatchObject({ skipped: true });
    expect(inviteEvents()).toEqual([]);
    expect(state().status).toBe("completed");
  });

  it("the unattended runner never records it: only a preview reviewed on /cadences does", async () => {
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE");
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: PLAY,
      dryRun: false,
      linkedIn: caller({}),
    });
    expect(out.action).toBe("skipped");
    expect(inviteEvents()).toEqual([]);
  });
});

describe("LinkedIn says a known connection is not connected", () => {
  async function connectedThenRefused(): Promise<void> {
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE");
    await shown();
    await send(caller({}));
    await shown();
    const out = await send(caller({ message: notConnected }));
    expect(out.action).toBe("skipped");
    expect(out.note).toMatch(/not connected: preview again to draft the connection request/);
  }

  it("withdraws the record, frees the profile and drafts the request at the message's step", async () => {
    await connectedThenRefused();
    expect(inviteEvents()).toEqual([
      [2, "sent", expect.objectContaining({ via: "profile-read" })],
      [2, "withdrawn", expect.objectContaining({ reason: "not-connected" })],
    ]);
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    expect(state().current_step).toBe(2);
    expect(ledger.getCadenceDraft({ prospectId, playName: PLAY })).toBeNull();

    const request = await shown();
    expect(request.payload).toMatchObject({ kind: "linkedin_invite", note: noteText });
    expect(request.subject).toMatch(/^LinkedIn connection request · /);
    expect(modelInputs.at(-1)).toMatch(/emailed 1 time on this and did not reply/);
  });

  it("frees the profile before withdrawing: when it can't, nothing is recorded and Send retries", async () => {
    emailCadenceRunOut();
    profileRead("FIRST_DEGREE");
    await shown();
    await send(caller({}));
    await shown();
    const shared = getSharedDb();
    const release = vi.spyOn(shared, "releaseLinkedInTouch").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const err = await send(caller({ message: notConnected })).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/shared invite record could not be updated/);
    expect(inviteEvents().map(([step, status]) => [step, status])).toEqual([[2, "sent"]]);
    expect(shared.linkedInTouch("dana-lee")).toMatchObject({ source: "connected:alpha" });
    // The step and its preview stay; the failure shows on /cadences.
    expect(state().current_step).toBe(2);
    expect(state().last_send_error).toMatch(/could not be updated/);
    expect(ledger.getCadenceDraft({ prospectId, playName: PLAY })).not.toBeNull();

    release.mockRestore();
    const retried = await send(caller({ message: notConnected }));
    expect(retried.note).toMatch(/preview again to draft the connection request/);
    expect(inviteEvents().map(([step, status]) => [step, status])).toEqual([
      [2, "sent"],
      [2, "withdrawn"],
    ]);
    expect(shared.linkedInTouch("dana-lee")).toBeNull();
  });

  it("sending the request keeps the step; message 1 follows the acceptance", async () => {
    await connectedThenRefused();
    await shown();
    calls = [];
    const li = caller({
      account: () => ({ limits: { invites: { limit: 25, remaining: 20, resets_at: null } } }),
      invite: () => ({ invitation_id: "inv-7", status: "sent" }),
    });
    const out = await send(li);
    expect(out.action).toBe("step-sent");
    expect(kinds()).toEqual(["account", "invite"]);
    expect(calls[1]).toMatchObject({
      idempotencyKey: `gtm:alpha:cadence:${prospectId}:${PLAY}:2:invite`,
      note: noteText,
    });
    // Recorded where the connection was; message 1 is still the next step.
    expect(inviteEvents().map(([step, status]) => [step, status])).toEqual([
      [2, "sent"],
      [2, "withdrawn"],
      [2, "sent"],
    ]);
    expect(state().current_step).toBe(2);
    expect(Date.parse(state().next_due_at!)).toBeGreaterThan(Date.now());
    expect(await previewCadenceStep({ prospectId, playName: PLAY })).toMatchObject({
      waiting: true,
    });

    await sweepLinkedInInvitations({
      linkedIn: caller({
        invitations: () => ({
          invitations: [
            { invitation_id: "inv-7", status: "accepted", accepted_at: "2026-10-01T09:00:00Z" },
          ],
        }),
      }),
    });
    makeDue();
    const first = await shown();
    expect(first.payload.kind).toBe("linkedin_message");
    expect(modelInputs.at(-1)).toContain(
      "MESSAGE: first message after they accepted the connection request",
    );
    expect(modelInputs.at(-1)).not.toContain("ALREADY_CONNECTED");
  });

  it("a later not_connected on a real invite is a plain deferral, never another request", async () => {
    await connectedThenRefused();
    await shown();
    await send(
      caller({
        account: () => ({ limits: { invites: { limit: 25, remaining: 20, resets_at: null } } }),
        invite: () => ({ invitation_id: "inv-7", status: "sent" }),
      }),
    );
    // Accepted, and LinkedIn still says no: the step stays due, unchanged.
    ledger.updateLinkedInInviteEvent({
      id: ledger.listLinkedInInviteEvents(prospectId, PLAY).at(-1)!.id,
      metadata: { acceptedAt: "2026-10-01T09:00:00Z" },
    });
    makeDue();
    await shown();
    const err = await send(caller({ message: notConnected })).catch((e: unknown) => e);
    expect((err as Error).name).toBe("SendDeferredError");
    expect(inviteEvents()).toHaveLength(3);
  });
});

describe("a LinkedIn-first cadence from a known connection's queue row", () => {
  function fromQueue(): void {
    const queueId = ledger.enqueueTarget({
      playName: PLAY,
      payload: { name: "Dana Lee", linkedinUrl: PROFILE },
      dedupeKey: "dana-li",
      source: "find:test",
    })!;
    const out = recordKnownConnection({
      row: {
        id: queueId,
        playName: PLAY,
        payload: { name: "Dana Lee", linkedinUrl: PROFILE },
        notes: null,
      },
      connection: { readAt: new Date().toISOString() },
      sender: { accountId: "acct-1", workspace: "alpha" },
      workspace: "alpha",
    });
    if (!out.sent) throw new Error(out.flags.join(", "));
    prospectId = out.prospectId;
  }

  it("a cadence that cannot be enrolled leaves no record and frees the profile", () => {
    const plan = vi.spyOn(ledger, "saveCadencePlan").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => fromQueue()).toThrow("disk full");
    plan.mockRestore();
    const found = ledger.resolveProspectForLinkedInReply({ linkedinUrl: PROFILE });
    if (found.status === "matched") {
      expect(ledger.listLinkedInInviteEvents(found.prospectId, PLAY)).toEqual([]);
      expect(ledger.getCadence(found.prospectId, PLAY)).toBeNull();
    }
    expect(getSharedDb().linkedInTouch("dana-lee")).toBeNull();
    // Sent again, it records once.
    fromQueue();
    expect(ledger.listLinkedInInviteEvents(prospectId, PLAY)).toHaveLength(1);
  });

  it("starts at message 1, due now, with nothing to wait for", async () => {
    fromQueue();
    expect(state()).toMatchObject({ channel: "linkedin", current_step: 0 });
    expect(Date.parse(state().next_due_at!)).toBeLessThanOrEqual(Date.now());
    const first = await shown();
    expect(first.payload.kind).toBe("linkedin_message");
    expect(modelInputs.at(-1)).toContain("ALREADY_CONNECTED:");
  });

  it("not connected: the request is drafted as a plain first touch, sent at step 0", async () => {
    fromQueue();
    await shown();
    await send(caller({ message: notConnected }));
    const request = await shown();
    expect(request.payload.kind).toBe("linkedin_invite");
    // Nobody was emailed: the note is not told they were.
    expect(modelInputs.at(-1)).not.toContain("PRIOR_CONTACT");
    calls = [];
    await send(
      caller({
        account: () => ({ limits: { invites: { limit: 25, remaining: 20, resets_at: null } } }),
        invite: () => ({ invitation_id: "inv-8", status: "sent" }),
      }),
    );
    expect(kinds()).toEqual(["account", "invite"]);
    expect(inviteEvents().map(([step, status]) => [step, status])).toEqual([
      [0, "sent"],
      [0, "withdrawn"],
      [0, "sent"],
    ]);
    expect(state().current_step).toBe(0);
    expect(await previewCadenceStep({ prospectId, playName: PLAY })).toMatchObject({
      waiting: true,
    });
  });
});
