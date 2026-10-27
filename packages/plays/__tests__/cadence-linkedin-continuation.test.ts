import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
// The prompt-input tests pin the model writer; the templates block sets its own.
let linkedinCfg: Record<string, unknown> = { writer: "model" };
let noteText = "Hi Dana, good to see another person working on review. How is it going?";
const promptNames: string[] = [];
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
      linkedinContinuation: continuationOn,
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

const {
  Ledger,
  isSendDeferred,
  getLinkedInInboxStore,
  getSharedDb,
  importTouchedProfiles,
  parseTouchedFile,
  _resetInviteLimitsCacheForTests,
} = await import("@oneshot-gtm/core");
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
  continueCadencesOntoLinkedIn,
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
// What message 1 and the close of an accepted continuation were told before
// already-connected people were written for, captured from main as it stood: a
// stranger's input must not change by a byte.
const ACCEPTED_FIRST_INPUT = [
  "FOUNDER: Founder",
  "PRODUCT: a GTM workspace",
  "PERSON: Dana Lee",
  "PRIOR_CONTACT: they were emailed on this and did not reply. Don't re-pitch and don't refer to the unanswered email.",
  "MESSAGE: first message after they accepted the connection request",
  "PRIOR TOUCHES:",
  "  STEP 2: Hi Dana, good to see another person working on review. How is it going?",
  "PRODUCT: a GTM workspace",
  "MAX_CHARS: 400",
].join("\n");
const ACCEPTED_LAST_INPUT = [
  "FOUNDER: Founder",
  "PRODUCT: a GTM workspace",
  "PRODUCT_BRIEF: (none)",
  "PERSON: Dana Lee",
  "READER_ROLE: unknown",
  "PRIOR_CONTACT: they were emailed on this and did not reply. Don't re-pitch and don't refer to the unanswered email.",
  "MESSAGE: last message — a short, graceful close",
  "READER_ROLE is unknown: make the OFFER when one is given; otherwise describe the product in one sentence. End with the easy out.",
  "PRIOR TOUCHES:",
  "  STEP 2: Hi Dana, good to see another person working on review. How is it going?",
  "  STEP 3: Dana, what are you building right now?",
  "PRODUCT: a GTM workspace",
  "MAX_CHARS: 400",
].join("\n");
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
  linkedinCfg = { writer: "model" };
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

  it("reads the trigger off the linked row when the send names no source", () => {
    ledger.upsertTrigger({
      name: "repo-stars",
      configJson: JSON.stringify({ linkedinContinuation: false }),
    });
    ledger.upsertTrigger({
      name: "repo-forks",
      configJson: JSON.stringify({ linkedinContinuation: true }),
    });
    const stars = ledger.enqueueTarget({
      playName: PLAY,
      payload: { email: "dana@example.com", name: "Dana Lee" },
      dedupeKey: "dana-stars",
      source: "find:repo-stars",
    })!;
    ledger.enqueueTarget({
      playName: PLAY,
      payload: { email: "dana@example.com", name: "Dana Lee" },
      dedupeKey: "dana-forks",
      source: "find:repo-forks",
    });
    enrollInCadence({ prospectId, playName: PLAY, queueId: stars });
    expect(state().queue_id).toBe(stars);
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

  it("is told the sequence's offer as context, never the intro row's own copy", async () => {
    const row = ledger.enqueueTarget({
      playName: PLAY,
      payload: {
        email: "dana@example.com",
        name: "Dana Lee",
        offer: { offer: "the intro row's old offer", steps: "x" },
      },
      dedupeKey: "dana",
      source: "find:test",
    })!;
    ledger.setQueueStatus({ id: row, status: "sent" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "hello", body: "hello" },
    });
    enrollInCadence({
      prospectId,
      playName: PLAY,
      queueId: row,
      offer: { offer: "get every review merged the day it opens", steps: "reviews it" },
    });
    ledger.advanceCadence({ prospectId, playName: PLAY, newStep: 1, nextDueAt: null });
    await previewCadenceStep({ prospectId, playName: PLAY });
    expect(modelInputs[0]).toContain(
      "OFFER (context only; the note never makes it): get every review merged the day it opens",
    );
    expect(modelInputs[0]).not.toContain("the intro row's old offer");
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

  it("holds a note that still puts the founder in the reader's batch after repair", async () => {
    noteText = "Hey Dana, in YC F26 as well. How are you handling review?";
    emailCadenceRunOut();
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview)
      throw new Error("the invite step never waits");
    expect(preview.flags).toContainEqual(expect.stringMatching(/^shared-cohort: /));
    const out = await run(inviteOk());
    expect(out.action).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("stores on the invite whether its note carried an evidence clause, as drafted (#792)", async () => {
    // Email intro with a repo signal: the note is drafted with a clause.
    ledger.recordSequenceEvent({
      prospectId,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "hello", body: "hello", repo: "acme/widgets" },
    });
    enrollInCadence({ prospectId, playName: PLAY });
    ledger.advanceCadence({
      prospectId,
      playName: PLAY,
      newStep: 1,
      nextDueAt: "2000-01-01T00:00:00.000Z",
    });
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview) throw new Error("the invite never waits");
    expect(preview.payload).toMatchObject({ kind: "linkedin_invite", evidenceClause: true });
    await run(inviteOk(), { persistedPayload: preview.payload });
    const [sent] = ledger.listLinkedInInviteEvents(prospectId, PLAY);
    expect(JSON.parse(sent!.metadata_json!)).toMatchObject({ evidenceClause: true });
  });

  it("stores evidenceClause false when the note was drafted without a clause (#792)", async () => {
    emailCadenceRunOut();
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview) throw new Error("the invite never waits");
    expect(preview.payload).toMatchObject({ evidenceClause: false });
    await run(inviteOk(), { persistedPayload: preview.payload });
    const [sent] = ledger.listLinkedInInviteEvents(prospectId, PLAY);
    expect(JSON.parse(sent!.metadata_json!)).toMatchObject({ evidenceClause: false });
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
      accountWorkspace: "alpha",
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
      idempotencyKey: `gtm:alpha:cadence:${prospectId}:${PLAY}:3`,
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

  it("records who ended the invite: the timeout (#792)", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk());
    sql(
      `UPDATE sequence_events SET created_at = datetime('now', '-25 days')
        WHERE prospect_id = ${prospectId} AND channel = 'linkedin'`,
    );
    makeDue();
    await run(
      caller({
        invitation: () => ({ invitation_id: "inv-1", status: "pending", accepted_at: null }),
        withdraw: () => ({ status: "withdrawn" }),
      }),
    );
    const timedOut = ledger
      .listLinkedInInviteEvents(prospectId, PLAY)
      .find((e) => e.status === "withdrawn")!;
    expect(JSON.parse(timedOut.metadata_json!)).toMatchObject({ withdrawnBy: "timeout" });
  });

  it("records a withdrawal OneShot reports as manual (#792)", async () => {
    emailCadenceRunOut();
    await sendInvite(inviteOk());
    makeDue();
    await run(
      caller({
        invitation: () => ({ invitation_id: "inv-1", status: "withdrawn", accepted_at: null }),
      }),
    );
    const byHand = ledger
      .listLinkedInInviteEvents(prospectId, PLAY)
      .find((e) => e.status === "withdrawn")!;
    expect(JSON.parse(byHand.metadata_json!)).toMatchObject({ withdrawnBy: "manual" });
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

  it("the close carries the brief and role; an unknown role names no outcome", async () => {
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
    expect(known).toMatch(/name one concrete outcome the product could deliver/);

    sql(`UPDATE prospects SET title = NULL`);
    await previewPayload();
    const unknown = modelInputs.at(-1)!;
    expect(unknown).toContain("READER_ROLE: unknown");
    expect(unknown).toMatch(/otherwise describe the product in one sentence/);
    expect(unknown).not.toMatch(/name one concrete outcome/);
  });
});

describe("already connected: the messages are written knowing it", () => {
  const ALREADY = "ALREADY_CONNECTED:";
  const ALREADY_LINE =
    "ALREADY_CONNECTED: you were already connected on LinkedIn before this sequence; no connection request was sent or accepted.";
  const ACCEPTED_MESSAGE = "MESSAGE: first message after they accepted the connection request";
  const note = "Hi Dana, good to see another person working on review. How is it going?";

  async function preview(linkedIn?: ReturnType<typeof caller>) {
    const shown = await previewCadenceStep({
      prospectId,
      playName: PLAY,
      ...(linkedIn ? { linkedIn } : {}),
    });
    if ("waiting" in shown || "skipped" in shown) throw new Error("nothing to draft");
    return shown;
  }

  /** The invite went out as `status` answered it; a `sent` one is then accepted. linkedin:1 is due. */
  async function invited(status: "sent" | "already_connected"): Promise<void> {
    emailCadenceRunOut();
    await sendInvite(inviteOk(status));
    if (status === "sent") {
      await sweepLinkedInInvitations({
        linkedIn: caller({
          invitations: () => ({
            invitations: [
              { invitation_id: "inv-1", status: "accepted", accepted_at: "2026-10-01T09:00:00Z" },
            ],
          }),
        }),
      });
    }
    makeDue();
  }

  /** linkedin:1 goes out as drafted (`text`) and linkedin:2 is due. */
  async function firstSent(text: string): Promise<void> {
    noteText = text;
    const li = caller({ message: () => ({ status: "sent", conversation_id: "conv-1" }) });
    const first = await preview(li);
    await run(li, { persistedPayload: first.payload });
    noteText = note;
    makeDue();
  }

  beforeEach(async () => {
    const { _resetLinkedInLiveReads } = await import("../src/index.ts");
    _resetLinkedInLiveReads();
  });

  it("an accepted invite: message 1's input is byte for byte what it was before (regression)", async () => {
    await invited("sent");
    await preview();
    const input = modelInputs.at(-1)!;
    expect(input).not.toContain(ALREADY);
    expect(input).toContain(`\n${ACCEPTED_MESSAGE}\n`);
    expect(input).toContain(`PRIOR TOUCHES:\n  STEP 2: ${note}\n`);
    expect(input).toBe(ACCEPTED_FIRST_INPUT);
  });

  it("an accepted invite: the close's input is byte for byte what it was before (regression)", async () => {
    await invited("sent");
    await firstSent("Dana, what are you building right now?");
    await preview();
    const input = modelInputs.at(-1)!;
    expect(input).not.toContain(ALREADY);
    expect(input).toContain(`STEP 2: ${note}`);
    expect(input).toBe(ACCEPTED_LAST_INPUT);
  });

  it("already connected: message 1 says so, drops the request framing and the undelivered note", async () => {
    await invited("already_connected");
    await preview();
    const input = modelInputs.at(-1)!;
    expect(input).toContain(
      `\n${ALREADY_LINE}\nMESSAGE: first message on LinkedIn — you were already connected\n`,
    );
    expect(input).not.toContain(ACCEPTED_MESSAGE);
    expect(input).not.toContain(note);
    expect(input).toContain("PRIOR TOUCHES:\n  (none recorded)\n");
  });

  it("already connected: message 1 is otherwise the input an accepted invite gets", async () => {
    await invited("already_connected");
    await preview();
    const expected = ACCEPTED_FIRST_INPUT.replace(
      ACCEPTED_MESSAGE,
      `${ALREADY_LINE}\nMESSAGE: first message on LinkedIn — you were already connected`,
    ).replace(`  STEP 2: ${note}`, "  (none recorded)");
    expect(modelInputs.at(-1)).toBe(expected);
  });

  it("already connected: the close says so too, with its own MESSAGE line and message 1 but not the note", async () => {
    await invited("already_connected");
    const first = "Dana, what are you building right now?";
    await firstSent(first);
    await preview();
    const input = modelInputs.at(-1)!;
    expect(input).toContain(`\n${ALREADY_LINE}\nMESSAGE: last message — a short, graceful close\n`);
    expect(input).toContain(`PRIOR TOUCHES:\n  STEP 3: ${first}\n`);
    expect(input).not.toContain(note);
    const expected = ACCEPTED_LAST_INPUT.replace(
      "MESSAGE: last message",
      `${ALREADY_LINE}\nMESSAGE: last message`,
    ).replace(`  STEP 2: ${note}\n`, "");
    expect(input).toBe(expected);
  });

  it("the prompt documents ALREADY_CONNECTED and keeps its opening line for strangers", () => {
    const prompt = readFileSync(
      join(import.meta.dirname, "..", "..", "prompts", "linkedin-message.md"),
      "utf8",
    );
    expect(prompt.split("\n")[0]).toBe(
      "You write one LinkedIn message from the founder to a person who accepted their connection request.",
    );
    expect(prompt).toMatch(/^- `ALREADY_CONNECTED` \(optional\): /m);
    const section = prompt.split("## Already connected")[1]!.split("\n## ")[0]!;
    expect(section).toMatch(/Never thank them for connecting/);
    expect(section).toMatch(/never mention a connection request/);
    expect(section).toMatch(/Don't claim to know them or imply familiarity/);
    // It overrides the stranger-path rules that assume an accepted request.
    expect(section).toMatch(/takes precedence/);
    expect(section).toMatch(/"pick up from the note"/);
    expect(section).toMatch(/"thank them briefly for connecting"/);
    // It defers to the rules below rather than restating them: a restated
    // "one open question … no pitch" contradicts the offer-first first message.
    expect(section).toMatch(/every rule for the first and last message below still holds\./);
    expect(section).not.toMatch(/one open question|no pitch/);
  });

  it("both LinkedIn prompts say the founder is in no program unless SENDER_COHORT says so", () => {
    for (const name of ["linkedin-message.md", "linkedin-invite-note.md"]) {
      const prompt = readFileSync(join(import.meta.dirname, "..", "..", "prompts", name), "utf8");
      expect(prompt, name).toMatch(/^- `SENDER_COHORT` \(optional, usually absent\): /m);
      const section = prompt.split("## You are in no program")[1]!.split("\n## ")[0]!;
      expect(section, name).toMatch(/never a program the founder is in/);
      expect(section, name).toMatch(/no subject/);
    }
  });
});

describe("continueCadencesOntoLinkedIn: cadences enrolled before the setting", () => {
  /** An email cadence enrolled with the setting off, at `status`. */
  function enrolledBefore(id: number, status: "active" | "completed" | "breakup"): void {
    continuationOn = false;
    enrollInCadence({ prospectId: id, playName: PLAY });
    if (status !== "active") {
      ledger.recordSequenceEvent({
        prospectId: id,
        playName: PLAY,
        stepIndex: 1,
        channel: "email",
        status: "sent",
        metadata: { subject: "hello", body: "hello" },
      });
      ledger.setCadenceStatus({ prospectId: id, playName: PLAY, status });
    }
    continuationOn = true;
  }
  const planIds = (id = prospectId) =>
    ledger.getCadencePlan(id, PLAY, ledger.getCadence(id, PLAY)!.enrolled_at)?.map((s) => s.id) ??
    effectiveSequence(PLAY, id)!.steps.map((s) => s.id);

  it("counts without --write, then appends the LinkedIn steps once", () => {
    enrolledBefore(prospectId, "active");
    const dry = continueCadencesOntoLinkedIn({ write: false });
    expect(dry.extended.map((e) => e.prospectId)).toEqual([prospectId]);
    expect(planIds()).toEqual(["base:1"]);

    continueCadencesOntoLinkedIn({ write: true });
    expect(planIds()).toEqual(["base:1", "linkedin:invite", "linkedin:1", "linkedin:2"]);
    expect(state().status).toBe("active");
    expect(effectiveSequence(PLAY, prospectId)!.steps.map((s) => s.channel)).toEqual([
      "email",
      "linkedin",
      "linkedin",
      "linkedin",
    ]);

    const again = continueCadencesOntoLinkedIn({ write: true });
    expect(again.extended).toEqual([]);
    expect(again.skipped["already-on-linkedin"]).toBe(1);
  });

  it("reopens an ended cadence at the connection request, spread at the invite share", () => {
    const second = newProspect({
      name: "Jo Moss",
      email: "jo@example.com",
      linkedin_url: "https://www.linkedin.com/in/jo-moss",
    });
    enrolledBefore(prospectId, "completed");
    enrolledBefore(second, "breakup");
    const now = new Date("2026-10-16T09:00:00Z");
    const result = continueCadencesOntoLinkedIn({ write: true, now, perDay: 1 });
    expect(result.skipped).toEqual({});
    expect(result.extended).toHaveLength(2);
    expect(result.extended.map((e) => e.dueAt).toSorted()).toEqual([
      "2026-10-16T09:00:00.000Z",
      "2026-10-17T09:00:00.000Z",
    ]);
    for (const id of [prospectId, second]) {
      const c = ledger.getCadence(id, PLAY)!;
      expect(c.status).toBe("active");
      // The step after the last email: the connection request, not the email again.
      expect(c.current_step).toBe(1);
      expect(effectiveSequence(PLAY, id)!.steps[c.current_step]!.id).toBe("linkedin:invite");
    }
  });

  it("leaves alone people who replied, have no profile, or were already contacted on LinkedIn", () => {
    enrolledBefore(prospectId, "completed");
    ledger.recordLinkedInReply({
      prospectId,
      source: "test",
      externalEventId: "reply-1",
      occurredAt: "2026-10-10T00:00:00Z",
    });
    const noProfile = newProspect({
      name: "No Url",
      email: "nourl@example.com",
      linkedin_url: null,
    });
    enrolledBefore(noProfile, "completed");
    const touched = newProspect({
      name: "Kim Park",
      email: "kim@example.com",
      linkedin_url: "https://www.linkedin.com/in/kim-park",
    });
    enrolledBefore(touched, "completed");
    importTouchedProfiles(
      getSharedDb(),
      parseTouchedFile("url\nhttps://www.linkedin.com/in/kim-park\n"),
      {
        source: "elsewhere",
      },
    );

    const result = continueCadencesOntoLinkedIn({ write: true });
    expect(result.extended).toEqual([]);
    expect(result.skipped["replied"]).toBe(1);
    expect(result.skipped["no-linkedin-profile"]).toBe(1);
    expect(Object.values(result.skipped).reduce((a, b) => a + b, 0)).toBe(3);
    for (const id of [prospectId, noProfile, touched])
      expect(ledger.getCadence(id, PLAY)!.status).toBe("completed");
  });
});

describe("templates: the default writer", () => {
  const OFFER = "get every host's follow-ups sent the same day.";

  /** The email intro went out with this evidence (and offer); the invite step is due. */
  function started(metadata: Record<string, unknown>, offer?: string): void {
    ledger.recordSequenceEvent({
      prospectId,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "hello", body: "hello", ...metadata },
    });
    enrollInCadence({
      prospectId,
      playName: PLAY,
      ...(offer ? { offer: { offer, steps: "drafts them" }, offerOrigin: "derived" as const } : {}),
    });
    ledger.advanceCadence({
      prospectId,
      playName: PLAY,
      newStep: 1,
      nextDueAt: "2000-01-01T00:00:00.000Z",
    });
  }

  async function shown() {
    const preview = await previewCadenceStep({ prospectId, playName: PLAY });
    if ("waiting" in preview || "skipped" in preview) throw new Error("nothing to draft");
    return preview;
  }

  /** The invite goes out with the shown note and is answered `status`; a `sent` one is accepted. */
  async function invite(note: string, status: "sent" | "already_connected"): Promise<void> {
    noteText = note;
    await sendInvite(inviteOk(status));
    if (status === "sent") {
      await sweepLinkedInInvitations({
        linkedIn: caller({
          invitations: () => ({
            invitations: [
              { invitation_id: "inv-1", status: "accepted", accepted_at: "2026-10-01T09:00:00Z" },
            ],
          }),
        }),
      });
    }
    makeDue();
  }

  /** The shown message goes out as is; the next step is due. */
  async function send(preview: Awaited<ReturnType<typeof shown>>): Promise<void> {
    const li = caller({ message: () => ({ status: "sent", conversation_id: "conv-1" }) });
    await run(li, { persistedPayload: preview.payload });
    makeDue();
  }

  beforeEach(async () => {
    linkedinCfg = {};
    const { _resetLinkedInLiveReads } = await import("../src/index.ts");
    _resetLinkedInLiveReads();
  });

  it("with nothing set, every step is the shipped default, filled, with no model call", async () => {
    started({ repo: "acme/widgets" }, OFFER);
    const note = await shown();
    expect(note.body).toBe("Hi Dana, saw you starred acme/widgets. Would be good to connect.");
    expect(note.payload).toMatchObject({ kind: "linkedin_invite", evidenceClause: true });
    await invite(note.body, "sent");
    const first = await shown();
    expect(first.body).toBe("Hi Dana, thanks for connecting. What are you working on right now?");
    await send(first);
    const last = await shown();
    expect(last.body).toBe(
      "Hi Dana, last one from me, no reply needed. One thing I'd like to do for you: get every host's follow-ups sent the same day. Want me to run a small version? A no is fine too.",
    );
    expect(modelInputs).toEqual([]);
  });

  it("the workspace's own text wins, and a step without its value uses its fallback", async () => {
    linkedinCfg = {
      templates: {
        note: "hey {first_name} - saw {evidence}. working on the same thing.",
        noteFallback: "hey {first_name} - would be good to connect.",
        firstMessageConnected: "hey {first_name}, so what are you building right now?",
        lastMessage: "hey {first_name}, the one I'd run for you: {offer}.",
        lastMessageFallback: "hey {first_name}, last one from me.",
      },
    };
    started({});
    const note = await shown();
    expect(note.body).toBe("hey Dana - would be good to connect.");
    expect(note.payload).toMatchObject({ evidenceClause: false });
    await invite(note.body, "already_connected");
    const first = await shown();
    expect(first.body).toBe("hey Dana, so what are you building right now?");
    await send(first);
    expect((await shown()).body).toBe("hey Dana, last one from me.");
    expect(modelInputs).toEqual([]);
  });

  it("a step the workspace leaves unset uses the shipped default", async () => {
    // Mid-batch, so the cohort reads "in YC F26", not "went through".
    vi.useFakeTimers({ now: new Date("2026-10-15T12:00:00Z"), toFake: ["Date"] });
    try {
      linkedinCfg = { templates: { note: "hey {first_name} - saw {evidence}." } };
      started({ prospectCohort: "yc-f26" }, OFFER);
      const note = await shown();
      expect(note.body).toBe("hey Dana - saw you're in YC F26.");
      await invite(note.body, "already_connected");
      expect((await shown()).body).toBe("Hi Dana, what are you working on right now?");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an over-long message carries its length flag on the payload, so the send holds", async () => {
    linkedinCfg = { templates: { firstMessageConnected: `hey {first_name}, ${"x".repeat(420)}` } };
    started({});
    const note = await shown();
    expect(note.payload).not.toHaveProperty("flags");
    await invite(note.body, "already_connected");
    const first = await shown();
    expect(first.payload).toMatchObject({ flags: ["too-long: 430/400 characters"] });
    expect(first.flags).toEqual(["too-long: 430/400 characters"]);
  });

  it("with no usable first name the greeting is dropped, never left empty", async () => {
    sql(`UPDATE prospects SET name = 'wanghley' WHERE id = ${prospectId}`);
    linkedinCfg = { templates: { note: "hey {first_name} - saw {evidence}. Good to connect." } };
    started({ repo: "acme/widgets" });
    expect((await shown()).body).toBe("Saw you starred acme/widgets. Good to connect.");
  });

  it("writer model keeps the prompt-written path", async () => {
    linkedinCfg = { writer: "model", templates: { note: "hey {first_name}." } };
    started({ repo: "acme/widgets" });
    expect((await shown()).body).toBe(noteText);
    expect(modelInputs).toHaveLength(1);
  });
});
