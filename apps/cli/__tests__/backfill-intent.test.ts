import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ledger } from "@oneshot-gtm/core";

// commandIntelBackfillIntent against a real ledger — zero network by
// construction: triageEmails is mocked, so no SDK/LLM import happens.
let ledger: Ledger;
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger };
});

const triageEmailsMock = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, triageEmails: triageEmailsMock };
});

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { commandIntelBackfillIntent } = await import("../src/commands/intel.ts");

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-backfill-intent-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new RealLedger(dbPath);
  triageEmailsMock.mockReset();
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

function record(id: string, kind: string | null, receivedAt = "2026-08-25T10:00:00.000Z"): void {
  ledger.recordInboxReply({
    id,
    threadKey: `t-${id}`,
    prospectId: 1,
    fromEmail: `${id}@prospect.example`,
    subject: "Re: x",
    body: "hello",
    receivedAt,
    kind: kind as never,
  });
}

describe("commandIntelBackfillIntent (issue #480)", () => {
  it("classifies every untriaged human reply and persists the intent", async () => {
    // A real prospect row so recordInboxReply's FK-shaped id resolves.
    ledger.upsertProspect({ email: "p@prospect.example" });
    record("r1", "human");
    record("r2", null); // pre-v23: NULL reads as human
    record("r3", "auto"); // never human — must not be sent to triage

    triageEmailsMock.mockImplementation(async (emails: Array<{ id: string }>) =>
      emails.map((e) => ({
        id: e.id,
        from: "x",
        subject: "x",
        category: "interested",
        nextStep: "book_call",
        draftedReply: "",
        reasoning: "asked to talk",
      })),
    );

    await commandIntelBackfillIntent();

    expect(triageEmailsMock).toHaveBeenCalledTimes(1);
    const sentIds = (triageEmailsMock.mock.calls[0]![0] as Array<{ id: string }>).map((e) => e.id);
    expect(new Set(sentIds)).toEqual(new Set(["r1", "r2"]));

    expect(ledger.listUntriagedHumanReplies()).toHaveLength(0);
  });

  it("skips a row the background poll has already claimed, and never bills it twice (#559)", async () => {
    ledger.upsertProspect({ email: "p@prospect.example" });
    record("r1", "human");
    record("r2", "human");
    // The scheduler's poll is mid-triage on r2: it holds the atomic claim.
    expect(ledger.claimInboxReplyForTriage("r2")).toBe(true);

    triageEmailsMock.mockImplementation(async (emails: Array<{ id: string }>) =>
      emails.map((e) => ({
        id: e.id,
        from: "x",
        subject: "x",
        category: "not_now",
        nextStep: "wait",
        draftedReply: "",
        reasoning: "later",
      })),
    );
    await commandIntelBackfillIntent();

    // r1 was triaged here; r2 was left to the poll that claimed it.
    const sentIds = (triageEmailsMock.mock.calls[0]![0] as Array<{ id: string }>).map((e) => e.id);
    expect(sentIds).toEqual(["r1"]);
    expect(ledger.listInboxReplyIntents(["r1", "r2"]).get("r1")?.intent).toBe("not_now");
    // Still the poll's claim — a second claimant loses.
    expect(ledger.claimInboxReplyForTriage("r2")).toBe(false);
  });

  it("is a no-op when nothing is untriaged", async () => {
    await commandIntelBackfillIntent();
    expect(triageEmailsMock).not.toHaveBeenCalled();
  });

  it("a batch failure is logged and skipped, not thrown", async () => {
    record("r1", "human");
    triageEmailsMock.mockRejectedValue(new Error("provider 503"));
    await expect(commandIntelBackfillIntent()).resolves.toBeUndefined();
    // The reply is still there, still untriaged — a triage failure never loses it.
    expect(ledger.listUntriagedHumanReplies().map((r) => r.id)).toEqual(["r1"]);
  });
});
