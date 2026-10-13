import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { Ledger as LedgerType } from "@oneshot-gtm/core";

// An email cadence that carries on onto LinkedIn (#789): the appended steps, the
// invite guard and quota, already-connected people, review-only sending, the
// timeout, and stopping on a reply. Real ledger, stubbed LinkedIn caller.

let ledger: LedgerType;
let dbPath: string;
let continuationOn = true;
let noteText = "Hi Dana, good to see another person working on review. How is it going?";
const promptNames: string[] = [];
const modelInputs: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    currentWorkspaceName: () => "gtm",
    loadConfig: () => ({
      founderName: "Founder",
      productOneLiner: "a GTM workspace",
      linkedinContinuation: continuationOn,
    }),
    linkedInConversationFor: () => null,
    linkedInOutreachAccount: () => ({ workspace: "gtm", accountId: "acct-1" }),
    hasAnySendCapacity: () => true,
    listInbox: async () => ({ emails: [], has_more: false }),
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => {
      promptNames.push(name);
      return "prompt";
    },
    complete: async (input: { messages: Array<{ content: string }> }) => {
      modelInputs.push(input.messages[1]!.content);
      return { content: noteText };
    },
  };
});

const { Ledger, isSendDeferred, getLinkedInInboxStore, _resetInviteLimitsCacheForTests } =
  await import("@oneshot-gtm/core");
const {
  enrollInCadence,
  effectiveSequence,
  runCadenceStepForProspect,
  previewCadenceStep,
  previewCadenceStepBatch,
  sendCadenceStepBatch,
  advanceCadence,
  sweepLinkedInInvitations,
  triggerLinkedInContinuation,
} = await import("../src/index.ts");
await import("../src/repo-interest.ts"); // registers a one-step email sequence

const PLAY = "repo-interest";
let prospectId: number;
let calls: Array<Record<string, unknown>>;

type Reply = (op: Record<string, unknown>) => unknown;
const accountOk = () => ({ limits: { invites: { limit: 25, remaining: 20, resets_at: null } } });
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
const inviteOk = (status = "sent") =>
  caller({
    account: accountOk,
    invite: () => ({ invitation_id: "inv-1", status }),
  });

function sql(statement: string): void {
  const db = new Database(dbPath);
  db.exec(statement);
  db.close();
}
const makeDue = (id = prospectId) =>
  sql(
    `UPDATE cadence_state SET next_due_at = '2000-01-01T00:00:00.000Z' WHERE prospect_id = ${id}`,
  );

/** The email intro went out and the cadence is parked on the first LinkedIn step. */
function emailCadenceRunOut(id = prospectId): void {
  ledger.recordSequenceEvent({
    prospectId: id,
    playName: PLAY,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    metadata: { subject: "hello", body: "hello" },
  });
  enrollInCadence({ prospectId: id, playName: PLAY });
  ledger.advanceCadence({
    prospectId: id,
    playName: PLAY,
    newStep: 1,
    nextDueAt: "2000-01-01T00:00:00.000Z",
  });
}

const run = (
  linkedIn: ReturnType<typeof caller> | undefined,
  extra: Record<string, unknown> = {},
) =>
  runCadenceStepForProspect({
    prospectId,
    playName: PLAY,
    dryRun: false,
    ...(linkedIn ? { linkedIn } : {}),
    ...extra,
  });
const sendInvite = (linkedIn: ReturnType<typeof caller>) =>
  run(linkedIn, { persistedPayload: { kind: "linkedin_invite", note: noteText } });
const state = () => ledger.getCadence(prospectId, PLAY)!;
const linkedinEvents = () =>
  ledger
    .listSequenceEventsForProspectPlay(prospectId, PLAY)
    .filter((e) => e.channel === "linkedin");

function newProspect(overrides: Record<string, unknown> = {}): number {
  return ledger.upsertProspect({
    name: "Dana Lee",
    email: "dana@example.com",
    linkedin_url: "https://www.linkedin.com/in/dana-lee",
    source: PLAY,
    ...overrides,
  });
}

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-li-continuation-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  // A fresh shared DB per test: the guard refuses a profile that was already invited.
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "li-continuation-"));
  _resetInviteLimitsCacheForTests();
  continuationOn = true;
  noteText = "Hi Dana, good to see another person working on review. How is it going?";
  promptNames.length = 0;
  modelInputs.length = 0;
  calls = [];
  prospectId = newProspect();
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

describe("the sequence", () => {
  it("is unchanged with the setting off", () => {
    continuationOn = false;
    expect(effectiveSequence(PLAY)!.steps.map((s) => s.channel)).toEqual(["email"]);
    enrollInCadence({ prospectId, playName: PLAY });
    const seq = effectiveSequence(PLAY, prospectId)!;
    expect(seq.steps.map((s) => s.channel)).toEqual(["email"]);
    expect(ledger.getCadencePlan(prospectId, PLAY, state().enrolled_at)).toHaveLength(1);
  });

  it("follows the email steps with linkedin:invite → linkedin:1 → linkedin:2 when on", () => {
    const seq = effectiveSequence(PLAY)!;
    expect(seq.steps.map((s) => s.channel)).toEqual(["email", "linkedin", "linkedin", "linkedin"]);
    expect(seq.steps.slice(1).map((s) => s.id)).toEqual([
      "linkedin:invite",
      "linkedin:1",
      "linkedin:2",
    ]);
    // Three days after the last email step.
    expect(seq.steps[1]!.dayOffset).toBe(3);
    enrollInCadence({ prospectId, playName: PLAY });
    expect(ledger.getCadencePlan(prospectId, PLAY, state().enrolled_at)!.map((s) => s.id)).toEqual([
      "base:1",
      "linkedin:invite",
      "linkedin:1",
      "linkedin:2",
    ]);
    // Still an email cadence: its intro is the first touch.
    expect(state().channel).toBe("email");
  });

  it("keeps a cadence in flight as it was when the setting is turned on later", () => {
    continuationOn = false;
    enrollInCadence({ prospectId, playName: PLAY });
    continuationOn = true;
    expect(effectiveSequence(PLAY, prospectId)!.steps).toHaveLength(1);
  });

  it("lets a trigger's own setting beat the workspace's, either way", () => {
    continuationOn = true;
    enrollInCadence({ prospectId, playName: PLAY, linkedinContinuation: false });
    expect(effectiveSequence(PLAY, prospectId)!.steps).toHaveLength(1);

    continuationOn = false;
    const other = newProspect({ email: "erin@example.com", name: "Erin Park" });
    enrollInCadence({ prospectId: other, playName: PLAY, linkedinContinuation: true });
    expect(effectiveSequence(PLAY, other)!.steps).toHaveLength(4);
  });

  it("reads the setting off the trigger a person was queued from", () => {
    ledger.upsertTrigger({
      name: "repo-stars",
      configJson: JSON.stringify({ linkedinContinuation: false }),
    });
    ledger.enqueueTarget({
      playName: PLAY,
      payload: { email: "dana@example.com", name: "Dana Lee" },
      dedupeKey: "dana",
      source: "find:repo-stars",
    });
    expect(triggerLinkedInContinuation(PLAY, prospectId)).toBe(false);
    enrollInCadence({ prospectId, playName: PLAY });
    expect(effectiveSequence(PLAY, prospectId)!.steps).toHaveLength(1);
  });

  it("uses the trigger of the row that sent, not a newer row from another trigger", () => {
    ledger.upsertTrigger({
      name: "repo-stars",
      configJson: JSON.stringify({ linkedinContinuation: false }),
    });
    ledger.upsertTrigger({
      name: "repo-forks",
      configJson: JSON.stringify({ linkedinContinuation: true }),
    });
    ledger.enqueueTarget({
      playName: PLAY,
      payload: { email: "dana@example.com", name: "Dana Lee" },
      dedupeKey: "dana-stars",
      source: "find:repo-stars",
    });
    ledger.enqueueTarget({
      playName: PLAY,
      payload: { email: "dana@example.com", name: "Dana Lee" },
      dedupeKey: "dana-forks",
      source: "find:repo-forks",
    });
    // The newest row says on; the row that sent said off.
    expect(triggerLinkedInContinuation(PLAY, prospectId)).toBe(true);
    expect(triggerLinkedInContinuation(PLAY, prospectId, "find:repo-stars")).toBe(false);
    enrollInCadence({ prospectId, playName: PLAY, queueSource: "find:repo-stars" });
    expect(effectiveSequence(PLAY, prospectId)!.steps).toHaveLength(1);
  });
});

describe("the connection request", () => {
  it("drafts with the invite-note prompt, told they were emailed and did not reply", async () => {
    emailCadenceRunOut();
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview)
      throw new Error("the invite step never waits");
    expect(promptNames).toContain("linkedin-invite-note");
    expect(modelInputs[0]).toContain("PRIOR_CONTACT:");
    expect(modelInputs[0]).toMatch(/emailed 1 time on this and did not reply/);
    expect(modelInputs[0]).toMatch(/Don't re-pitch/);
    // The note and its character count (limit 300) are what the draft shows.
    expect(preview.body).toBe(noteText);
    expect(preview.subject).toBe(`LinkedIn connection request · ${noteText.length}/300 characters`);
    expect(preview.flags).toEqual([]);
    expect(preview.payload).toMatchObject({ kind: "linkedin_invite", note: noteText });
    expect(calls).toEqual([]);
  });

  it("flags a note over 300 characters so it cannot be sent as is", async () => {
    noteText = "x".repeat(301);
    emailCadenceRunOut();
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    expect(preview).toMatchObject({ flags: ["note-too-long: 301/300 characters"] });
  });

  it("carries a note's remaining lint flags to the preview and holds the send", async () => {
    noteText = "Saw you at the meetup. More at https://example.com";
    emailCadenceRunOut();
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview)
      throw new Error("the invite step never waits");
    expect(preview.flags).toContainEqual(expect.stringMatching(/^note-link/));
    expect(preview.payload).toMatchObject({ kind: "linkedin_invite" });
    const out = await run(inviteOk());
    expect(out.action).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("is written at its own step with the marker, and there is no step-0 LinkedIn row", async () => {
    emailCadenceRunOut();
    const out = await sendInvite(inviteOk());
    expect(out.action).toBe("step-sent");
    expect(calls.find((c) => c.kind === "invite")).toMatchObject({
      kind: "invite",
      accountId: "acct-1",
      profile: "https://www.linkedin.com/in/dana-lee",
      note: noteText,
    });
    const invites = ledger.listLinkedInInviteEvents(prospectId, PLAY);
    expect(invites.map((e) => [e.step_index, e.status])).toEqual([[2, "sent"]]);
    expect(JSON.parse(invites[0]!.metadata_json!)).toMatchObject({
      kind: "linkedin_invite",
      note: noteText,
      invitationId: "inv-1",
      accountId: "acct-1",
      accountWorkspace: "gtm",
    });
    // The email intro is still the only step 0, so first-touch dedupe rests on it.
    const stepZero = ledger
      .listSequenceEventsForProspectPlay(prospectId, PLAY)
      .filter((e) => e.step_index === 0);
    expect(stepZero.map((e) => e.channel)).toEqual(["email"]);
    expect(state().current_step).toBe(2);
    expect(state().channel).toBe("email");
    expect(state().status).toBe("active");
  });

  it("is never sent by the unattended runner: only a draft reviewed on /cadences goes out", async () => {
    emailCadenceRunOut();
    const li = inviteOk();
    const out = await run(li);
    expect(out.action).toBe("skipped");
    expect(out.note).toMatch(/awaits review on \/cadences/);
    const swept = await advanceCadence({ dryRun: false, linkedIn: li });
    expect(swept.stepsExecuted).toBe(0);
    expect(calls).toEqual([]);
    expect(linkedinEvents()).toEqual([]);
    expect(state().current_step).toBe(1);
  });

  it("is sent from the batch send like any reviewed follow-up", async () => {
    emailCadenceRunOut();
    await previewCadenceStep({ prospectId, playName: PLAY });
    const results = await sendCadenceStepBatch(
      [{ prospectId, playName: PLAY }],
      undefined,
      inviteOk(),
    );
    expect(results).toEqual([expect.objectContaining({ ok: true, action: "step-sent" })]);
    expect(kinds()).toContain("invite");
    expect(ledger.listLinkedInInviteEvents(prospectId, PLAY)).toHaveLength(1);
  });
});

describe("guards and quota", () => {
  it("a guard refusal records the step as skipped with the reason, and the cadence completes", async () => {
    ledger.close();
    ledger = new Ledger(dbPath);
    const odd = newProspect({ email: "bot@example.com", name: "SWE-agent" });
    prospectId = odd;
    emailCadenceRunOut(odd);
    const out = await run(inviteOk());
    expect(out.action).toBe("completed");
    expect(out.note).toMatch(/not-a-person/);
    expect(calls).toEqual([]);
    const skipped = linkedinEvents();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ step_index: 2, status: "skipped" });
    expect(JSON.parse(skipped[0]!.metadata_json!).reason).toMatch(/^not-a-person:/);
    expect(state().status).toBe("completed");
    expect(ledger.listLinkedInInviteEvents(odd, PLAY)).toEqual([]);
  });

  it("previewing the invite of a refused person skips the step and completes the cadence, with no note drafted", async () => {
    ledger.close();
    ledger = new Ledger(dbPath);
    const odd = newProspect({ email: "bot2@example.com", name: "SWE-agent" });
    prospectId = odd;
    emailCadenceRunOut(odd);
    // Nothing but `cadence advance` runs the send path unprompted, and a refused
    // person can never be sent: the preview takes the same outcome.
    const shown = await previewCadenceStep({ prospectId: odd, playName: PLAY });
    expect(shown).toMatchObject({ skipped: true });
    expect((shown as { message: string }).message).toMatch(
      /^not-a-person:.* — LinkedIn steps skipped$/,
    );
    expect(modelInputs).toEqual([]);
    expect(ledger.getCadenceDraft({ prospectId: odd, playName: PLAY })).toBeNull();
    const skipped = linkedinEvents();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ step_index: 2, status: "skipped" });
    expect(JSON.parse(skipped[0]!.metadata_json!).reason).toMatch(/^not-a-person:/);
    expect(state().status).toBe("completed");
    expect(ledger.listLinkedInInviteEvents(odd, PLAY)).toEqual([]);
    // Done is done: a second look does not record a second skip.
    await expect(previewCadenceStep({ prospectId: odd, playName: PLAY })).rejects.toThrow(
      /cadence is completed/,
    );
    expect(linkedinEvents()).toHaveLength(1);
  });

  it("previewing the invite of someone with no usable profile completes the cadence too", async () => {
    ledger.close();
    ledger = new Ledger(dbPath);
    const page = newProspect({
      email: "acme@example.com",
      linkedin_url: "https://www.linkedin.com/company/acme",
    });
    prospectId = page;
    emailCadenceRunOut(page);
    const shown = await previewCadenceStep({ prospectId: page, playName: PLAY });
    expect(shown).toMatchObject({ skipped: true });
    expect((shown as { message: string }).message).toMatch(/ — LinkedIn steps skipped$/);
    expect(modelInputs).toEqual([]);
    expect(linkedinEvents()).toHaveLength(1);
    expect(linkedinEvents()[0]).toMatchObject({ step_index: 2, status: "skipped" });
    expect(state().status).toBe("completed");
  });

  it("a batch preview reports the refused person and still drafts for the others", async () => {
    ledger.close();
    ledger = new Ledger(dbPath);
    const fine = newProspect();
    emailCadenceRunOut(fine);
    const odd = newProspect({ email: "bot3@example.com", name: "SWE-agent" });
    emailCadenceRunOut(odd);
    const out = await previewCadenceStepBatch([
      { prospectId: fine, playName: PLAY },
      { prospectId: odd, playName: PLAY },
    ]);
    expect(out[0]).toMatchObject({ prospectId: fine, ok: true });
    expect(out[1]).toMatchObject({ prospectId: odd, ok: false });
    expect(out[1]!.error).toMatch(/^not-a-person:.* — LinkedIn steps skipped$/);
    expect(ledger.getCadence(odd, PLAY)!.status).toBe("completed");
    expect(ledger.getCadence(fine, PLAY)!.status).toBe("active");
  });

  it("an existing conversation: the guard skips the invite step with its reason, before any invite", async () => {
    // Its own person: the inbox store is a process-wide singleton, so the saved thread must not match anyone else.
    prospectId = newProspect({
      email: "sam@example.com",
      name: "Sam Roe",
      linkedin_url: "https://www.linkedin.com/in/sam-roe",
    });
    const store = getLinkedInInboxStore();
    store.saveConversation(
      "acct-key",
      {
        id: "chat-sam",
        attendees: [
          { provider_id: "ACo-self", profile_url: null, is_self: true },
          {
            provider_id: "ACo-sam",
            profile_url: "https://www.linkedin.com/in/sam-roe",
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
        conversation_id: "chat-sam",
        direction: "outbound",
        sender_provider_id: "ACo-self",
        sender_name: "Me",
        text: "good to see you last week",
        sent_at: "2026-01-01T00:00:00Z",
        deleted: false,
      } as never,
    ]);
    emailCadenceRunOut();
    const out = await run(inviteOk());
    expect(out.action).toBe("completed");
    expect(out.note).toMatch(/already-in-conversation/);
    expect(calls).toEqual([]);
    expect(linkedinEvents()[0]).toMatchObject({ step_index: 2, status: "skipped" });
    expect(JSON.parse(linkedinEvents()[0]!.metadata_json!).reason).toMatch(
      /^already-in-conversation:/,
    );
    expect(state().status).toBe("completed");
  });

  it("a quota deferral leaves the step due", async () => {
    emailCadenceRunOut();
    const capped = caller({
      account: () => ({ limits: { invites: { limit: 25, remaining: 0, resets_at: null } } }),
    });
    const err = await sendInvite(capped).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["account"]);
    expect(state().current_step).toBe(1);
    expect(state().status).toBe("active");
    expect(linkedinEvents()).toEqual([]);
    // The profile was freed: tomorrow's send goes out.
    _resetInviteLimitsCacheForTests();
    calls = [];
    expect((await sendInvite(inviteOk())).action).toBe("step-sent");
  });

  it("someone with no usable LinkedIn profile skips all three steps and the cadence completes", async () => {
    const noProfile = newProspect({
      email: "nobody@example.com",
      name: "Nia Holt",
      linkedin_url: "https://github.com/nia",
    });
    prospectId = noProfile;
    emailCadenceRunOut(noProfile);
    for (let i = 0; i < 3; i++) {
      const out = await run(inviteOk());
      expect(out.action).toBe("skipped");
      expect(out.note).toMatch(/no LinkedIn profile/);
    }
    expect(calls).toEqual([]);
    expect(linkedinEvents().map((e) => [e.step_index, e.status])).toEqual([
      [2, "skipped"],
      [3, "skipped"],
      [4, "skipped"],
    ]);
    expect(state().status).toBe("completed");
  });
});

describe("after the invite", () => {
  it("an accept recorded by the sweep makes linkedin:1 due, and nothing is sent until /cadences sends it", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk());
    makeDue();
    calls = [];

    // Pending: the step waits, drafts nothing, sends nothing.
    const pending = caller({
      invitation: () => ({ invitation_id: "inv-1", status: "pending", accepted_at: null }),
    });
    const waiting = await run(pending);
    expect(waiting.action).toBe("waiting");
    const shown = await previewCadenceStep({ prospectId, playName: PLAY });
    expect(shown).toMatchObject({ waiting: true });

    // The sweep records the accept and does nothing else.
    calls = [];
    const sweep = caller({
      invitations: () => ({
        invitations: [
          { invitation_id: "inv-1", status: "accepted", accepted_at: "2026-10-01T09:00:00Z" },
        ],
      }),
    });
    const result = await sweepLinkedInInvitations({ linkedIn: sweep });
    expect(result.accepted).toBe(1);
    expect(kinds()).toEqual(["invitations"]);
    makeDue();

    // Due now, yet the unattended runner sends nothing.
    calls = [];
    const li = caller({
      message: () => ({ status: "sent", conversation_id: "conv-1" }),
    });
    const unattended = await run(li);
    expect(unattended.action).toBe("skipped");
    expect(unattended.note).toMatch(/awaits review on \/cadences/);
    await advanceCadence({ dryRun: false, linkedIn: li });
    expect(calls).toEqual([]);
    expect(state().current_step).toBe(2);

    // Previewed on /cadences, then sent from there.
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview)
      throw new Error("accepted: nothing to wait for");
    expect(preview.payload.kind).toBe("linkedin_message");
    const sent = await run(li, { persistedPayload: preview.payload });
    expect(sent.action).toBe("step-sent");
    expect(kinds()).toEqual(["message"]);
    expect(state().current_step).toBe(3);
  });

  it("already_connected with no conversation goes straight to linkedin:1, sent with `message`", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk("already_connected"));
    expect(ledger.listLinkedInInviteEvents(prospectId, PLAY)).toHaveLength(1);
    calls = [];
    const li = caller({ message: () => ({ status: "sent", conversation_id: "conv-9" }) });
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview)
      throw new Error("already connected: nothing to wait for");
    expect(preview.payload.kind).toBe("linkedin_message");
    const out = await run(li, { persistedPayload: preview.payload });
    expect(out.action).toBe("step-sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "message",
      accountId: "acct-1",
      profile: "https://www.linkedin.com/in/dana-lee",
      idempotencyKey: `gtm:gtm:cadence:${prospectId}:${PLAY}:3`,
    });
    expect(state().current_step).toBe(3);
  });

  it("withdraws an invite still pending after 21 days and completes the cadence", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk());
    sql(
      `UPDATE sequence_events SET created_at = datetime('now', '-25 days')
        WHERE prospect_id = ${prospectId} AND channel = 'linkedin'`,
    );
    makeDue();
    calls = [];
    const li = caller({
      invitation: () => ({ invitation_id: "inv-1", status: "pending", accepted_at: null }),
      withdraw: () => ({ status: "withdrawn" }),
    });
    const out = await run(li);
    expect(out.action).toBe("completed");
    expect(kinds()).toEqual(["invitation", "withdraw"]);
    expect(
      ledger.listLinkedInInviteEvents(prospectId, PLAY).map((e) => [e.step_index, e.status]),
    ).toEqual([
      [2, "sent"],
      [2, "withdrawn"],
    ]);
    expect(state().status).toBe("stopped");
  });
});

describe("stopping", () => {
  it("a reply by email stops the whole cadence, LinkedIn steps included", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk());
    ledger.recordProspectReply(prospectId, { subject: "Re: hello" });
    expect(state().status).toBe("replied");
    calls = [];
    const out = await run(caller({}));
    expect(out).toMatchObject({ action: "skipped", note: "cadence is replied" });
    expect(calls).toEqual([]);
  });

  it("a reply on LinkedIn stops it", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk());
    ledger.recordLinkedInReply({
      prospectId,
      source: "linkedin",
      externalEventId: "m-1",
      occurredAt: "2026-10-02T09:00:00Z",
      body: "thanks, happy to connect",
    });
    expect(state().status).toBe("replied");
  });

  it("the guard refuses an invite to someone who already replied", async () => {
    emailCadenceRunOut();
    ledger.recordLinkedInReply({
      prospectId,
      source: "linkedin",
      externalEventId: "m-2",
      occurredAt: "2026-10-02T09:00:00Z",
    });
    // The cadence is already stopped by the reply; nothing runs, nothing is sent.
    const out = await run(inviteOk());
    expect(out.action).toBe("skipped");
    expect(calls).toEqual([]);
  });
});

const profileReply = (headline: string) => (op: Record<string, unknown>) => ({
  profile: { headline, identifier: op["identifier"] },
});

describe("evidence-aware prompts (#790)", () => {
  function firstTouch(metadata: Record<string, unknown>): void {
    ledger.recordSequenceEvent({
      prospectId,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "hello", body: "hello", ...metadata },
    });
    enrollInCadence({ prospectId, playName: PLAY });
    ledger.advanceCadence({
      prospectId,
      playName: PLAY,
      newStep: 1,
      nextDueAt: "2000-01-01T00:00:00.000Z",
    });
  }

  async function previewPayload(linkedIn?: ReturnType<typeof caller>) {
    const preview = await previewCadenceStep({
      prospectId,
      playName: PLAY,
      ...(linkedIn ? { linkedIn } : {}),
    });
    if ("waiting" in preview || "skipped" in preview) throw new Error("not waiting");
    return preview;
  }

  beforeEach(async () => {
    const { _resetLinkedInLiveReads } = await import("../src/index.ts");
    _resetLinkedInLiveReads();
  });

  it("the note gets the aged evidence clause, the buyer type and a no-infra-pitch instruction", async () => {
    firstTouch({ repo: "acme/widgets", buyerType: "enterprise" });
    await previewPayload();
    expect(modelInputs[0]).toContain("EVIDENCE_CLAUSE: starred acme/widgets");
    expect(modelInputs[0]).toContain("BUYER_TYPE: enterprise");
    expect(modelInputs[0]).toMatch(/Keep the infra pitch out of the note/);
  });

  it("a stale stack is left out of the note", async () => {
    firstTouch({ vendorStack: "Playwright" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: PLAY,
      stepIndex: 9,
      channel: "email",
      status: "sent",
      metadata: {},
    });
    sql(
      `UPDATE sequence_events SET created_at = '2020-01-01 00:00:00' WHERE prospect_id = ${prospectId}`,
    );
    await previewPayload();
    expect(modelInputs[0]).not.toContain("EVIDENCE_CLAUSE");
  });

  it("message 1 names the company only after a live read agrees, and reads once for message 1 and the close", async () => {
    sql(`UPDATE prospects SET title = 'CEO', company = 'Soren', email = 'dana@usesoren.com'`);
    firstTouch({ buyerType: "startup" });
    await sendInvite(inviteOk("already_connected"));
    calls = [];
    const li = caller({
      profile: profileReply("CEO at Soren"),
      message: () => ({ status: "sent", conversation_id: "conv-1" }),
    });
    const first = await previewPayload(li);
    expect(modelInputs.at(-1)).toContain("COMPANY_THEY_RUN: Soren");
    expect(modelInputs.at(-1)).toContain("PRIOR_CONTACT: they were emailed");
    expect(modelInputs.at(-1)).toContain("BUYER_TYPE: startup");
    await run(li, { persistedPayload: first.payload });
    makeDue();
    await previewPayload(li);
    expect(modelInputs.at(-1)).toContain("COMPANY_THEY_RUN: Soren");
    expect(calls.filter((c) => c["kind"] === "profile")).toHaveLength(1);
    expect(calls.find((c) => c["kind"] === "profile")).toMatchObject({
      accountId: "acct-1",
      identifier: "https://www.linkedin.com/in/dana-lee",
    });
  });

  it("a live headline naming another company, or no live read, leaves the company out", async () => {
    sql(`UPDATE prospects SET title = 'CEO', company = 'Soren', email = 'dana@usesoren.com'`);
    firstTouch({});
    await sendInvite(inviteOk("already_connected"));
    await previewPayload(caller({ profile: profileReply("Founder at Otherco") }));
    expect(modelInputs.at(-1)).not.toContain("COMPANY_THEY_RUN");
    const { _resetLinkedInLiveReads } = await import("../src/index.ts");
    _resetLinkedInLiveReads();
    await previewPayload();
    expect(modelInputs.at(-1)).not.toContain("COMPANY_THEY_RUN");
  });

  it("the close carries the brief and role; an unknown role carries no goal", async () => {
    sql(`UPDATE prospects SET title = 'Head of Growth'`);
    firstTouch({});
    await sendInvite(inviteOk("already_connected"));
    const li = caller({ message: () => ({ status: "sent", conversation_id: "conv-1" }) });
    const first = await previewPayload(li);
    await run(li, { persistedPayload: first.payload });
    makeDue();
    await previewPayload();
    const known = modelInputs.at(-1)!;
    expect(known).toContain("READER_ROLE: growth or operations");
    expect(known).toContain("PRODUCT_BRIEF:");
    expect(known).toMatch(/Name one concrete goal/);

    sql(`UPDATE prospects SET title = NULL`);
    await previewPayload();
    const unknown = modelInputs.at(-1)!;
    expect(unknown).toContain("READER_ROLE: unknown");
    expect(unknown).toMatch(/Name no goal/);
    expect(unknown).not.toMatch(/Name one concrete goal/);
  });
});
