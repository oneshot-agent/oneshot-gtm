import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { Ledger as LedgerType } from "@oneshot-gtm/core";

// LinkedIn cadences against a real ledger: the LinkedIn sequence, waiting for
// the invite to be accepted, the timeout withdraw, the message send, and the
// skip-and-advance for a step whose channel has no address.

let ledger: LedgerType;
let dbPath: string;
let conversation: { conversationId: string; accountId: string; workspace: string } | null = null;
let messageText = "Thanks for connecting — how are you handling review today?";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    currentWorkspaceName: () => "gtm",
    loadConfig: () => ({ founderName: "Founder", productOneLiner: "a GTM workspace" }),
    linkedInConversationFor: () => conversation,
    linkedInOutreachAccount: () => ({ workspace: "gtm", accountId: "acct-1" }),
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "prompt",
    complete: async () => ({ content: messageText }),
  };
});

const { Ledger } = await import("@oneshot-gtm/core");
const { enrollInCadence, effectiveSequence, runCadenceStepForProspect, previewCadenceStep } =
  await import("../src/_cadence.ts");
await import("../src/repo-interest.ts"); // registers a one-step email sequence

let prospectId: number;

function inviteSentDaysAgo(days: number): void {
  ledger.recordSequenceEvent({
    prospectId,
    playName: "luma-events",
    stepIndex: 0,
    channel: "linkedin",
    status: "sent",
    metadata: { note: "saw you hosted", body: "saw you hosted", invitationId: "inv-1" },
  });
  const db = new Database(dbPath);
  db.exec(
    `UPDATE sequence_events SET created_at = datetime('now', '-${days} days') WHERE prospect_id = ${prospectId}`,
  );
  db.close();
}

function dueNow(playName: string): void {
  const db = new Database(dbPath);
  db.exec(
    `UPDATE cadence_state SET next_due_at = '2000-01-01T00:00:00.000Z' WHERE play_name = '${playName}'`,
  );
  db.close();
}

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-cadence-li-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  prospectId = ledger.upsertProspect({
    name: "Dana Lee",
    email: null,
    linkedin_url: "https://www.linkedin.com/in/dana-lee",
    source: "luma-events",
  });
  conversation = null;
  messageText = "Thanks for connecting — how are you handling review today?";
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

describe("LinkedIn cadence", () => {
  it("a LinkedIn enrollment runs the LinkedIn sequence, whatever the play", () => {
    inviteSentDaysAgo(0);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    const cadence = ledger.getCadence(prospectId, "luma-events")!;
    expect(cadence.channel).toBe("linkedin");
    const seq = effectiveSequence("luma-events", prospectId)!;
    expect(seq.steps.map((s) => s.channel)).toEqual(["linkedin", "linkedin"]);
  });

  it("waits a day while the invite hasn't been accepted, without drafting", async () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
    });
    expect(out.action).toBe("waiting");
    const cadence = ledger.getCadence(prospectId, "luma-events")!;
    expect(cadence.current_step).toBe(0);
    expect(Date.parse(cadence.next_due_at!)).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    await expect(previewCadenceStep({ prospectId, playName: "luma-events" })).rejects.toThrow(
      /hasn't been accepted/,
    );
  });

  it("withdraws the invite and stops the cadence after the timeout", async () => {
    inviteSentDaysAgo(25);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const calls: Array<[string, Record<string, unknown>]> = [];
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      linkedIn: async (workspace, op) => {
        calls.push([workspace, op as Record<string, unknown>]);
        return { status: "withdrawn" };
      },
    });
    expect(calls[0]![1]).toMatchObject({
      kind: "withdraw",
      accountId: "acct-1",
      invitationId: "inv-1",
    });
    expect(out.action).toBe("completed");
    expect(ledger.getCadence(prospectId, "luma-events")!.status).toBe("stopped");
    const events = ledger.listLinkedInInviteEvents(prospectId, "luma-events");
    expect(events.map((e) => e.status)).toEqual(["sent", "withdrawn"]);
  });

  it("once accepted, sends the reviewed message into the conversation and advances", async () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    conversation = { conversationId: "conv-9", accountId: "acct-1", workspace: "gtm" };
    const calls: Array<Record<string, unknown>> = [];
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      persistedPayload: { kind: "linkedin_message", text: "reviewed message" },
      linkedIn: async (_workspace, op) => {
        calls.push(op as Record<string, unknown>);
        return { status: "sent" };
      },
    });
    expect(calls[0]).toMatchObject({
      kind: "reply",
      conversationId: "conv-9",
      text: "reviewed message",
      idempotencyKey: `gtm:gtm:cadence:${prospectId}:luma-events:1`,
    });
    expect(out.action).toBe("step-sent");
    expect(ledger.getCadence(prospectId, "luma-events")!.current_step).toBe(1);
    const sent = ledger
      .listSequenceEventsForProspectPlay(prospectId, "luma-events")
      .find((e) => e.step_index === 1);
    expect(sent).toMatchObject({ channel: "linkedin", status: "sent" });
  });

  it("previews a message once accepted", async () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    conversation = { conversationId: "conv-9", accountId: "acct-1", workspace: "gtm" };
    const preview = await previewCadenceStep({ prospectId, playName: "luma-events" });
    expect(preview).toMatchObject({ subject: "LinkedIn message", flags: [] });
    expect(preview.body).toContain("Thanks for connecting");
  });
});

describe("LinkedIn cadence edge cases", () => {
  it("times out on the newest invite and withdraws that one", async () => {
    inviteSentDaysAgo(30);
    ledger.recordSequenceEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 0,
      channel: "linkedin",
      status: "withdrawn",
      metadata: { invitationId: "inv-1" },
    });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 0,
      channel: "linkedin",
      status: "sent",
      metadata: { note: "again", invitationId: "inv-2" },
    });
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const calls: Array<Record<string, unknown>> = [];
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      linkedIn: async (_w, op) => {
        calls.push(op as Record<string, unknown>);
        return { status: "withdrawn" };
      },
    });
    // The fresh invite is inside its window: wait, withdraw nothing.
    expect(out.action).toBe("waiting");
    expect(calls).toHaveLength(0);
  });

  it("withdraws through the account that sent the invite", async () => {
    ledger.recordSequenceEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 0,
      channel: "linkedin",
      status: "sent",
      metadata: { invitationId: "inv-9", accountId: "acct-old", accountWorkspace: "sdk" },
    });
    const db = new Database(dbPath);
    db.exec(`UPDATE sequence_events SET created_at = datetime('now', '-25 days')`);
    db.close();
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const calls: Array<[string, Record<string, unknown>]> = [];
    await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      linkedIn: async (workspace, op) => {
        calls.push([workspace, op as Record<string, unknown>]);
        return { status: "withdrawn" };
      },
    });
    expect(calls[0]).toEqual([
      "sdk",
      expect.objectContaining({ accountId: "acct-old", invitationId: "inv-9" }),
    ]);
  });

  it("records no withdrawal when the invite was no longer pending", async () => {
    inviteSentDaysAgo(25);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      linkedIn: async () => ({ status: "not_pending" }),
    });
    const events = ledger.listLinkedInInviteEvents(prospectId, "luma-events");
    expect(events.map((e) => e.status)).toEqual(["sent"]);
    expect(ledger.getCadence(prospectId, "luma-events")!.status).toBe("stopped");
  });

  it("a failed withdrawal keeps the cadence and retries tomorrow", async () => {
    inviteSentDaysAgo(25);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      linkedIn: async () => {
        throw new Error("Tool request failed");
      },
    });
    expect(out.action).toBe("waiting");
    const cadence = ledger.getCadence(prospectId, "luma-events")!;
    expect(cadence.status).toBe("active");
    expect(Date.parse(cadence.next_due_at!)).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
  });

  it("flags a message over the LinkedIn limit so it can't be sent as is", async () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    conversation = { conversationId: "conv-9", accountId: "acct-1", workspace: "gtm" };
    messageText = "x".repeat(401);
    const preview = await previewCadenceStep({ prospectId, playName: "luma-events" });
    expect(preview.flags).toEqual(["too-long: 401/400 characters"]);
  });
});

describe("a LinkedIn invite that continues an email cadence (step N)", () => {
  function continuationInviteDaysAgo(days: number): void {
    ledger.recordSequenceEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    ledger.recordLinkedInInviteEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 2,
      status: "sent",
      metadata: { note: "n", invitationId: "inv-n" },
    });
    const db = new Database(dbPath);
    db.exec(
      `UPDATE sequence_events SET created_at = datetime('now', '-${days} days')
       WHERE prospect_id = ${prospectId} AND channel = 'linkedin'`,
    );
    db.close();
  }

  it("runs the 21-day clock from the invite's own created_at", async () => {
    continuationInviteDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
    });
    expect(out.action).toBe("waiting");
  });

  it("withdraws after the timeout and records the withdrawal on the invite's step", async () => {
    continuationInviteDaysAgo(25);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    dueNow("luma-events");
    const calls: Array<Record<string, unknown>> = [];
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "luma-events",
      dryRun: false,
      linkedIn: async (_w, op) => {
        calls.push(op as Record<string, unknown>);
        return { status: "withdrawn" };
      },
    });
    expect(calls[0]).toMatchObject({ kind: "withdraw", invitationId: "inv-n" });
    expect(out.action).toBe("completed");
    const events = ledger.listLinkedInInviteEvents(prospectId, "luma-events");
    expect(events.map((e) => [e.step_index, e.status])).toEqual([
      [2, "sent"],
      [2, "withdrawn"],
    ]);
    expect(ledger.getCadence(prospectId, "luma-events")!.status).toBe("stopped");
  });
});

describe("a step on a channel the person has no address for", () => {
  it("is skipped and the cadence moves on instead of staying due", async () => {
    // An email sequence for a prospect with no email.
    enrollInCadence({ prospectId, playName: "repo-interest" });
    dueNow("repo-interest");
    const out = await runCadenceStepForProspect({
      prospectId,
      playName: "repo-interest",
      dryRun: false,
    });
    expect(out.action).toBe("skipped");
    expect(out.note).toMatch(/no email/);
    expect(ledger.getCadence(prospectId, "repo-interest")!.status).toBe("completed");
    const skipped = ledger
      .listSequenceEventsForProspectPlay(prospectId, "repo-interest")
      .find((e) => e.step_index === 1);
    expect(skipped).toMatchObject({ channel: "email", status: "skipped" });
  });
});
