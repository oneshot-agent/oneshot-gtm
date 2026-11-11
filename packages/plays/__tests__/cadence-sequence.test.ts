import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { Ledger as LedgerType } from "@oneshot-gtm/core";

// The /cadences sheet's sequence read: the LinkedIn touches sent, the invite
// waited on, and the steps left, with each LinkedIn message's template text.

let ledger: LedgerType;
let dbPath: string;
let conversation: { conversationId: string; accountId: string; workspace: string } | null = null;
let linkedin: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    currentWorkspaceName: () => "alpha",
    loadConfig: () => ({ founderName: "Founder", productOneLiner: "a GTM workspace", linkedin }),
    linkedInConversationFor: () => conversation,
    linkedInOutreachAccount: () => ({ workspace: "alpha", accountId: "acct-1" }),
    linkedInInviteTimeoutDays: () => 21,
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "prompt",
    complete: async () => {
      throw new Error("the sequence read never calls a model");
    },
  };
});

const { Ledger } = await import("@oneshot-gtm/core");
const { enrollInCadence, cadenceSequence } = await import("../src/_cadence.ts");

let prospectId: number;

function inviteSentDaysAgo(days: number): void {
  ledger.recordSequenceEvent({
    prospectId,
    playName: "luma-events",
    stepIndex: 0,
    channel: "linkedin",
    status: "sent",
    metadata: { note: "saw you hosted", label: "connection request", invitationId: "inv-1" },
  });
  const db = new Database(dbPath);
  db.exec(
    `UPDATE sequence_events SET created_at = datetime('now', '-${days} days') WHERE prospect_id = ${prospectId}`,
  );
  db.close();
}

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-cadence-seq-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  prospectId = ledger.upsertProspect({
    name: "Dana Lee",
    email: null,
    linkedin_url: "https://www.linkedin.com/in/dana-lee",
    source: "luma-events",
  });
  conversation = null;
  linkedin = {
    templates: {
      firstMessage: "Hi {first_name}, first one.",
      lastMessageFallback: "Last one, {first_name}.",
    },
  };
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

describe("cadenceSequence", () => {
  it("while the invite waits: the note sent, its expiry, and both messages as they will go", () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    const view = cadenceSequence(prospectId, "luma-events")!;
    expect(view.linkedInSent).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        label: "connection request",
        text: "saw you hosted",
      }),
    ]);
    expect(view.invite).toEqual({ sentOn: daysFromNow(-3), expiresOn: daysFromNow(18) });
    expect(view.upcoming).toEqual([
      {
        stepIndex: 1,
        label: "first LinkedIn message",
        channel: "linkedin",
        isBreakup: false,
        dayOffset: 2,
        awaitsAcceptance: true,
        text: "Hi Dana, first one.",
      },
      {
        stepIndex: 2,
        label: "LinkedIn breakup",
        channel: "linkedin",
        isBreakup: true,
        dayOffset: 6,
        awaitsAcceptance: false,
        text: "Last one, Dana.",
      },
    ]);
  });

  it("once accepted, nothing waits on the invite", () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    conversation = { conversationId: "c-1", accountId: "acct-1", workspace: "alpha" };
    const view = cadenceSequence(prospectId, "luma-events")!;
    expect(view.invite).toBeNull();
    expect(view.upcoming.map((s) => s.awaitsAcceptance)).toEqual([false, false]);
  });

  it("a model-written workspace shows no text ahead: it is written when due", () => {
    linkedin = { writer: "model" };
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    const view = cadenceSequence(prospectId, "luma-events")!;
    expect(view.upcoming.map((s) => s.text)).toEqual([null, null]);
  });

  it("a stopped cadence has nothing left and waits on nothing, but keeps what was sent", () => {
    inviteSentDaysAgo(3);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    ledger.stopCadence({ prospectId, playName: "luma-events", reason: "other" });
    const view = cadenceSequence(prospectId, "luma-events")!;
    expect(view.linkedInSent).toHaveLength(1);
    expect(view.invite).toBeNull();
    expect(view.upcoming).toEqual([]);
  });

  it("a message they answered still shows as received", () => {
    inviteSentDaysAgo(9);
    enrollInCadence({ prospectId, playName: "luma-events", channel: "linkedin" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 1,
      channel: "linkedin",
      status: "replied",
      metadata: { body: "Hi Dana, first one.", label: "first LinkedIn message" },
    });
    const view = cadenceSequence(prospectId, "luma-events")!;
    expect(view.linkedInSent.map((t) => [t.stepIndex, t.text])).toEqual([
      [0, "saw you hosted"],
      [1, "Hi Dana, first one."],
    ]);
  });

  it("null for a cadence that does not exist", () => {
    expect(cadenceSequence(prospectId, "luma-events")).toBeNull();
  });
});
