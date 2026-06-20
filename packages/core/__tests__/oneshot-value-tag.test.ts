import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tagOutcomeValue (SDK 0.22, goal-level): once an outcome is known, record the
// cadence's value to OneShot in ONE call via tagReceiptValue({goalId}) and mirror
// it onto the goal's local receipts for the /receipts UI. SDK + ledger singleton
// are mocked so no wallet/network/real ~/.oneshot-gtm.

const tagReceiptValue = vi.hoisted(() => vi.fn(async () => undefined));
const rocsByGoal = vi.hoisted(() =>
  vi.fn(async () => ({
    goals: [
      {
        goal_id: "goal_1",
        spend: "0.42",
        value: "5000",
        pending_value: "0",
        rocs: 11904.7,
        receipt_count: 4,
        outcomes: [],
      },
    ],
    period_days: 30,
  })),
);
const h = vi.hoisted(() => ({ ledger: null as unknown as import("../src/ledger.ts").Ledger }));

vi.mock("@oneshot-agent/sdk", () => ({
  OneShot: class {
    tagReceiptValue = tagReceiptValue;
    rocsByGoal = rocsByGoal;
  },
}));

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => h.ledger };
});

import { Ledger } from "../src/ledger.ts";
import { cadenceGoalId, cadenceRocs, tagOutcomeValue } from "../src/oneshot.ts";

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-value-tag-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  h.ledger = new Ledger(dbPath);
  process.env["AGENT_PRIVATE_KEY"] = "0xtest";
  tagReceiptValue.mockClear();
  rocsByGoal.mockClear();
});

afterEach(() => {
  h.ledger.close();
  delete process.env["AGENT_PRIVATE_KEY"];
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

/** Seed a prospect + `n` send receipts sharing the cadence's goalId. */
function seedCadence(
  playName: string,
  email: string,
  n = 1,
): { prospectId: number; goalId: string; receiptIds: number[] } {
  const ledger = h.ledger;
  const prospectId = ledger.upsertProspect({ email });
  const goalId = cadenceGoalId(playName, email);
  const receiptIds: number[] = [];
  for (let i = 0; i < n; i++) {
    receiptIds.push(
      ledger.recordReceipt({
        playName,
        callType: "email.send",
        oneshotRequestId: `${email}-${i}`,
        decisionContext: { goalId },
      }),
    );
  }
  return { prospectId, goalId, receiptIds };
}

describe("tagOutcomeValue (goal-level)", () => {
  it("records the goal once and mirrors the tag across all its receipts", async () => {
    const { prospectId, goalId, receiptIds } = seedCadence("show-hn", "p@x.dev", 2);

    const res = await tagOutcomeValue({
      prospectId,
      playName: "show-hn",
      valueTag: { type: "revenue", amount: 5000, label: "deal won" },
    });

    expect(res.tagged).toBe(true);
    // ONE platform call, addressed by the cadence goalId
    expect(tagReceiptValue).toHaveBeenCalledTimes(1);
    expect(tagReceiptValue).toHaveBeenCalledWith(
      { goalId },
      { type: "revenue", amount: 5000, label: "deal won" },
    );
    // every receipt in the goal is mirrored locally
    for (const id of receiptIds) {
      expect(JSON.parse(h.ledger.getReceipt(id)?.value_tag ?? "{}")).toEqual({
        type: "revenue",
        amount: 5000,
        label: "deal won",
      });
    }
  });

  it("no-ops when no receipt carries the cadence goal", async () => {
    const prospectId = h.ledger.upsertProspect({ email: "nobody@x.dev" });
    const res = await tagOutcomeValue({
      prospectId,
      playName: "show-hn",
      valueTag: { type: "engagement" },
    });
    expect(res.tagged).toBe(false);
    expect(tagReceiptValue).not.toHaveBeenCalled();
  });

  it("swallows a tagReceiptValue failure but still mirrors the tag locally", async () => {
    const { prospectId, receiptIds } = seedCadence("show-hn", "err@x.dev");
    tagReceiptValue.mockRejectedValueOnce(new Error("boom"));

    const res = await tagOutcomeValue({
      prospectId,
      playName: "show-hn",
      valueTag: { type: "engagement", label: "reply" },
    });

    expect(res.tagged).toBe(false);
    expect(JSON.parse(h.ledger.getReceipt(receiptIds[0] as number)?.value_tag ?? "{}")).toEqual({
      type: "engagement",
      label: "reply",
    });
  });

  it("does not downgrade a higher-value tag (revenue survives a later reply)", async () => {
    const { prospectId, receiptIds } = seedCadence("show-hn", "rev@x.dev");

    await tagOutcomeValue({
      prospectId,
      playName: "show-hn",
      valueTag: { type: "revenue", amount: 5000, label: "deal won" },
    });
    const res = await tagOutcomeValue({
      prospectId,
      playName: "show-hn",
      valueTag: { type: "engagement", label: "reply" },
    });

    expect(res.tagged).toBe(false);
    expect(tagReceiptValue).toHaveBeenCalledTimes(1); // only the revenue record
    expect(JSON.parse(h.ledger.getReceipt(receiptIds[0] as number)?.value_tag ?? "{}")).toEqual({
      type: "revenue",
      amount: 5000,
      label: "deal won",
    });
  });

  it("upgrades a lower-value tag and skips an identical re-tag", async () => {
    const { prospectId } = seedCadence("show-hn", "up@x.dev");

    await tagOutcomeValue({ prospectId, playName: "show-hn", valueTag: { type: "engagement" } });
    // identical re-tag → no-op (no second record, avoids platform double-count)
    await tagOutcomeValue({ prospectId, playName: "show-hn", valueTag: { type: "engagement" } });
    expect(tagReceiptValue).toHaveBeenCalledTimes(1);

    const res = await tagOutcomeValue({
      prospectId,
      playName: "show-hn",
      valueTag: { type: "meeting", label: "meeting booked" },
    });
    expect(res.tagged).toBe(true);
    expect(tagReceiptValue).toHaveBeenCalledTimes(2);
  });
});

describe("cadenceRocs", () => {
  it("maps the platform rollup to typed numbers", async () => {
    const goals = await cadenceRocs({ periodDays: 30 });
    expect(rocsByGoal).toHaveBeenCalledWith({ period: 30 });
    expect(goals).toEqual([
      {
        goalId: "goal_1",
        spend: 0.42,
        value: 5000,
        pendingValue: 0,
        rocs: 11904.7,
        receiptCount: 4,
      },
    ]);
  });

  it("omits the period when none is given (all-time)", async () => {
    await cadenceRocs();
    expect(rocsByGoal).toHaveBeenCalledWith({});
  });
});
