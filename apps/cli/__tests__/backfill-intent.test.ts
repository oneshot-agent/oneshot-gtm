import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ledger } from "@oneshot-gtm/core";

// commandIntelBackfillIntent against a real ledger: zero network by
// construction: classifyReplyIntent is mocked, so no SDK/LLM call happens.
let ledger: Ledger;
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger };
});

const classifyMock = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, classifyReplyIntent: classifyMock };
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
  classifyMock.mockReset();
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

function label(intent: string, extra: Record<string, unknown> = {}) {
  return {
    intent,
    reason: "why",
    confidence: 0.9,
    probabilities: { [intent]: 0.9 },
    classifier: "decisions:test-model",
    costMicros: 20,
    review: false,
    fellBack: false,
    ...extra,
  };
}

function sequenceEventCount(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM sequence_events").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("commandIntelBackfillIntent (issue #480)", () => {
  it("labels every untriaged human reply and persists the intent with its details", async () => {
    ledger.upsertProspect({ email: "p@prospect.example" });
    record("r1", "human");
    record("r2", null); // pre-v23: NULL reads as human
    record("r3", "auto"); // never human: never classified
    classifyMock.mockResolvedValue(label("interested"));

    await commandIntelBackfillIntent();

    const ids = classifyMock.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(new Set(ids)).toEqual(new Set(["r1", "r2"]));
    expect(ledger.listUntriagedHumanReplies()).toHaveLength(0);
    const got = ledger.listInboxReplyIntents(["r1"]).get("r1");
    expect(got).toMatchObject({
      intent: "interested",
      intentConfidence: 0.9,
      intentReview: false,
      intentClassifier: "decisions:test-model",
    });
  });

  it("skips a row the background poll has already claimed, and never bills it twice (#559)", async () => {
    ledger.upsertProspect({ email: "p@prospect.example" });
    record("r1", "human");
    record("r2", "human");
    // The scheduler's poll is mid-triage on r2: it holds the atomic claim.
    expect(ledger.claimInboxReplyForTriage("r2")).toBe(true);
    classifyMock.mockResolvedValue(label("not_now"));

    await commandIntelBackfillIntent();

    const ids = classifyMock.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["r1"]);
    expect(ledger.listInboxReplyIntents(["r1"]).get("r1")?.intent).toBe("not_now");
    // Still the poll's claim. A second claimant loses.
    expect(ledger.claimInboxReplyForTriage("r2")).toBe(false);
  });

  it("is a no-op when nothing is untriaged", async () => {
    await commandIntelBackfillIntent();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("a failure is logged and skipped, not thrown, and the claim is released", async () => {
    record("r1", "human");
    classifyMock.mockRejectedValue(new Error("provider 503"));
    await expect(commandIntelBackfillIntent()).resolves.toBeUndefined();
    // The reply is still there, still untriaged. A triage failure never loses it.
    expect(ledger.listUntriagedHumanReplies().map((r) => r.id)).toEqual(["r1"]);
  });

  it("--reclassify --dry-run classifies already-labelled replies but writes nothing", async () => {
    record("r1", "human");
    ledger.setInboxReplyIntent("r1", "other", "old");
    classifyMock.mockResolvedValue(label("meeting"));

    await commandIntelBackfillIntent({ reclassify: true, dryRun: true });

    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(ledger.listInboxReplyIntents(["r1"]).get("r1")?.intent).toBe("other");
  });

  it("--reclassify writes the new label and never triggers cadence or reply bookkeeping", async () => {
    record("r1", "human");
    ledger.setInboxReplyIntent("r1", "other", "old");
    classifyMock.mockResolvedValue(label("not_interested", { confidence: 0.3, review: true }));
    const before = sequenceEventCount();

    await commandIntelBackfillIntent({ reclassify: true });

    const got = ledger.listInboxReplyIntents(["r1"]).get("r1");
    expect(got).toMatchObject({ intent: "not_interested", intentReview: true });
    expect(sequenceEventCount()).toBe(before);
  });

  it("never replaces an existing unsubscribe unless --allow-unsubscribe-downgrade", async () => {
    record("r1", "human");
    ledger.setInboxReplyIntent("r1", "unsubscribe", "stop");
    classifyMock.mockResolvedValue(label("other"));

    await commandIntelBackfillIntent({ reclassify: true });
    expect(ledger.listInboxReplyIntents(["r1"]).get("r1")?.intent).toBe("unsubscribe");

    await commandIntelBackfillIntent({ reclassify: true, allowUnsubscribeDowngrade: true });
    expect(ledger.listInboxReplyIntents(["r1"]).get("r1")?.intent).toBe("other");
  });

  it("--since limits the reclassify window", async () => {
    record("old", "human", "2020-01-01T00:00:00.000Z");
    record("new", "human", new Date().toISOString());
    classifyMock.mockResolvedValue(label("question"));

    await commandIntelBackfillIntent({ reclassify: true, sinceDays: 7 });

    const ids = classifyMock.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["new"]);
  });

  it("--since applies before --limit on untriaged rows, so older rows never eat the batch", async () => {
    record("old1", "human", "2020-01-01T00:00:00.000Z");
    record("old2", "human", "2020-01-02T00:00:00.000Z");
    record("new", "human", new Date().toISOString());
    classifyMock.mockResolvedValue(label("question"));

    await commandIntelBackfillIntent({ sinceDays: 7, limit: 1 });

    const ids = classifyMock.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["new"]);
  });
});
