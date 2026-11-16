import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both run-done paths (run now and the scheduled loop) write one finder_runs
// row through recordRunDone, and a failed write never fails the run. Same
// fake ledger as registry-outage-retry.test.ts.

interface FakeRow {
  name: string;
  enabled: number;
  config_json: string;
  last_polled_at: string | null;
  running_started_at: string | null;
  company_batch_seq: number;
  last_run_summary: string | null;
  retry_after: string | null;
  outage_retries: number;
}

const fakeStore: Record<string, FakeRow> = {};
const insertFinderRun = vi.fn();
const events: Array<{ event: string; fields: Record<string, unknown> }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
    startRun: () => {},
    dailySpendStatus: () => ({ ceilingReached: false }),
    spendCeilingReason: () => "",
    tryReserveDailySpend: () => ({ granted: true, release: () => {} }),
    getLedger: () => ({
      getTrigger: (name: string): FakeRow | undefined => fakeStore[name],
      upsertTrigger: () => {},
      markTriggerRunning: () => true,
      updateTriggerLastPoll: (input: { name: string; summary: unknown }) => {
        const row = fakeStore[input.name];
        if (!row) return;
        row.running_started_at = null;
        row.last_polled_at = new Date().toISOString();
        row.last_run_summary = JSON.stringify(input.summary);
      },
      clearTriggerClaim: () => {},
      finderApprovalStats: () => ({ approved: 0, reviewed: 0, rate: null }),
      latestQueueId: () => 0,
      listPendingQueueAfterId: () => [],
      isQueueDuplicate: () => false,
      enqueueTarget: () => 0,
      findProspectByEmail: () => null,
      recordReceipt: () => 0,
      insertFinderRun,
    }),
  };
});

const { runTriggerNow, runDueTriggers, TRIGGERS } = await import("../src/registry.ts");

const NAME = "hiring-signal";
const DAY = 24 * 60 * 60 * 1000;
const RESULT = {
  source: "find:hiring-signal",
  candidates: 12,
  droppedIcp: 2,
  droppedDuplicate: 3,
  droppedEnrichment: 1,
  droppedRole: 1,
  enqueued: 5,
  costUsd: 0.42,
  halted: "max-cost cap (5)",
};
const EMPTY = { ...RESULT, candidates: 0, enqueued: 0, costUsd: 0, halted: undefined };

function seed(lastPolledAt: string): void {
  fakeStore[NAME] = {
    name: NAME,
    enabled: 1,
    config_json: JSON.stringify({
      roles: ["Engineer"],
      companies: ["Acme"],
      yourClaim: "we cut onboarding time in half",
      sinceDays: 14,
      limit: 25,
      maxCostUsd: 5,
      intervalMs: DAY,
    }),
    last_polled_at: lastPolledAt,
    running_started_at: null,
    company_batch_seq: 0,
    last_run_summary: null,
    retry_after: null,
    outage_retries: 0,
  };
}

const spec = TRIGGERS.find((s) => s.name === NAME)!;

const EXPECTED_ROW = {
  name: NAME,
  source: "find:hiring-signal",
  candidates: 12,
  enqueued: 5,
  droppedDuplicate: 3,
  droppedEnrichment: 1,
  droppedRole: 1,
  droppedIcp: 2,
  costUsd: 0.42,
  halted: "max-cost cap (5)",
};

beforeEach(() => {
  for (const k of Object.keys(fakeStore)) delete fakeStore[k];
  insertFinderRun.mockReset();
  events.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("finder_runs rows", () => {
  it("run now writes one row for the finished run", async () => {
    seed("2026-01-01T00:00:00.000Z");
    vi.spyOn(spec, "run").mockResolvedValue(RESULT);
    const before = Date.now();
    await runTriggerNow(NAME);
    expect(insertFinderRun).toHaveBeenCalledTimes(1);
    const row = insertFinderRun.mock.calls[0]![0];
    expect(row).toMatchObject(EXPECTED_ROW);
    expect(Date.parse(row.startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(row.finishedAt)).toBeGreaterThanOrEqual(Date.parse(row.startedAt));
    expect(events.filter((e) => e.event === "trigger.run.done")).toHaveLength(1);
  });

  it("the scheduled loop writes one row for each trigger that ran", async () => {
    seed(new Date(Date.now() - 2 * DAY).toISOString());
    vi.spyOn(spec, "run").mockResolvedValue(RESULT);
    for (const other of TRIGGERS) {
      if (other !== spec) vi.spyOn(other, "run").mockResolvedValue(EMPTY);
    }
    const outcomes = await runDueTriggers({ ignoreApprovalRate: true });
    expect(outcomes.find((o) => o.name === NAME)?.fired).toBe(true);
    const mine = insertFinderRun.mock.calls.filter((c) => c[0].name === NAME);
    expect(mine).toHaveLength(1);
    expect(mine[0]![0]).toMatchObject(EXPECTED_ROW);
  });

  it("a failed write is logged and the run still succeeds", async () => {
    seed("2026-01-01T00:00:00.000Z");
    insertFinderRun.mockImplementation(() => {
      throw new Error("database is locked");
    });
    vi.spyOn(spec, "run").mockResolvedValue(RESULT);
    const out = await runTriggerNow(NAME);
    expect(out.fired).toBe(true);
    expect(out.error).toBeUndefined();
    expect(events).toContainEqual({
      event: "error.swallowed",
      fields: { kind: "finder_runs.insert", message_120: "database is locked" },
    });
  });
});
