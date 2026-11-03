import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A run a OneShot outage hit is tried again soon (30 min, 1 h, 2 h) instead of
// a whole interval later, and its summary says why. Same fake ledger as
// registry-batch-cursor.test.ts; the outage comes from the real breaker in
// core, fed by a watched fake SDK inside the finder.

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

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    startRun: () => {},
    dailySpendStatus: () => ({ ceilingReached: false }),
    spendCeilingReason: () => "",
    tryReserveDailySpend: () => ({ granted: true, release: () => {} }),
    getLedger: () => ({
      getTrigger: (name: string): FakeRow | undefined => fakeStore[name],
      upsertTrigger: () => {},
      markTriggerRunning: () => true,
      updateTriggerLastPoll: (input: {
        name: string;
        summary: unknown;
        retryAfter?: string | null;
        outageRetries?: number;
      }) => {
        const row = fakeStore[input.name];
        if (!row) return;
        row.running_started_at = null;
        row.last_polled_at = new Date().toISOString();
        row.last_run_summary = JSON.stringify(input.summary);
        row.retry_after = input.retryAfter ?? null;
        row.outage_retries = input.outageRetries ?? 0;
      },
      clearTriggerClaim: () => {},
      finderApprovalStats: () => ({ approved: 0, reviewed: 0, rate: null }),
      latestQueueId: () => 0,
      listPendingQueueAfterId: () => [],
      isQueueDuplicate: () => false,
      enqueueTarget: () => 0,
      findProspectByEmail: () => null,
      recordReceipt: () => 0,
    }),
  };
});

const core = await import("@oneshot-gtm/core");
const { runTriggerNow, runDueTriggers, TRIGGERS, OUTAGE_RETRY_WAITS_MS } =
  await import("../src/registry.ts");

const NAME = "hiring-signal";
const CONFIG = {
  roles: ["Engineer"],
  companies: ["Acme"],
  yourClaim: "we cut onboarding time in half",
  sinceDays: 14,
  limit: 25,
  maxCostUsd: 5,
};
const DAY = 24 * 60 * 60 * 1000;
const EMPTY = {
  source: "find:hiring-signal",
  candidates: 0,
  droppedIcp: 0,
  droppedDuplicate: 0,
  droppedEnrichment: 0,
  enqueued: 0,
  costUsd: 0,
};

function seed(row: Partial<FakeRow> = {}): FakeRow {
  fakeStore[NAME] = {
    name: NAME,
    enabled: 1,
    config_json: JSON.stringify({ ...CONFIG, intervalMs: DAY }),
    last_polled_at: "2026-01-01T00:00:00.000Z",
    running_started_at: null,
    company_batch_seq: 0,
    last_run_summary: null,
    retry_after: null,
    outage_retries: 0,
    ...row,
  };
  return fakeStore[NAME]!;
}

const agent = core.watchAgent({
  companyFind: async () => {
    throw new Error(
      "payment rejected: settlement_pending: transaction did not confirm in time — expected $0.01",
    );
  },
});

/** The finder runs into the outage: eight failed lookups. */
function outageRun() {
  return async () => {
    for (let i = 0; i < 8; i++) await agent.companyFind().catch(() => {});
    return EMPTY;
  };
}

const spec = TRIGGERS.find((s) => s.name === NAME)!;

beforeEach(() => {
  for (const k of Object.keys(fakeStore)) delete fakeStore[k];
  core._resetPlatformHealth();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("outage retry", () => {
  it("a hit run is paused and due again in 30 minutes", async () => {
    const row = seed();
    vi.spyOn(spec, "run").mockImplementation(outageRun());
    const out = await runTriggerNow(NAME);
    expect(out.nextDueInMs).toBe(OUTAGE_RETRY_WAITS_MS[0]);
    expect(row.outage_retries).toBe(1);
    const summary = JSON.parse(row.last_run_summary!);
    expect(summary.paused).toBe("OneShot payments not settling");
    expect(summary.retryAt).toBe(row.retry_after);
    expect(Date.parse(row.retry_after!) - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it("backs off 1 h, then 2 h, then falls back to the interval", async () => {
    const row = seed({ outage_retries: 1 });
    vi.spyOn(spec, "run").mockImplementation(outageRun());
    expect((await runTriggerNow(NAME)).nextDueInMs).toBe(OUTAGE_RETRY_WAITS_MS[1]);
    expect(row.outage_retries).toBe(2);
    core._resetPlatformHealth();
    expect((await runTriggerNow(NAME)).nextDueInMs).toBe(OUTAGE_RETRY_WAITS_MS[2]);
    expect(row.outage_retries).toBe(3);
    core._resetPlatformHealth();
    expect((await runTriggerNow(NAME)).nextDueInMs).toBe(DAY);
    expect(row.retry_after).toBeNull();
    expect(row.outage_retries).toBe(0);
    expect(JSON.parse(row.last_run_summary!).paused).toBe("OneShot payments not settling");
  });

  it("a clean run clears the retry", async () => {
    const row = seed({ outage_retries: 2, retry_after: "2026-01-01T00:30:00.000Z" });
    vi.spyOn(spec, "run").mockResolvedValue(EMPTY);
    const out = await runTriggerNow(NAME);
    expect(out.nextDueInMs).toBe(DAY);
    expect(row.retry_after).toBeNull();
    expect(row.outage_retries).toBe(0);
    expect(JSON.parse(row.last_run_summary!).paused).toBeUndefined();
  });

  it("a thrown run hit by the outage is retried soon too", async () => {
    const row = seed();
    vi.spyOn(spec, "run").mockImplementation(async () => {
      await outageRun()();
      throw new Error("boom");
    });
    const out = await runTriggerNow(NAME);
    expect(out.error).toBe("boom");
    expect(out.nextDueInMs).toBe(OUTAGE_RETRY_WAITS_MS[0]);
    expect(JSON.parse(row.last_run_summary!)).toMatchObject({
      error: "boom",
      paused: "OneShot payments not settling",
    });
  });

  it("the scheduled loop runs a trigger at its retry time, before its interval", async () => {
    const now = Date.now();
    seed({
      last_polled_at: new Date(now - 60 * 60_000).toISOString(),
      retry_after: new Date(now - 1000).toISOString(),
      outage_retries: 1,
    });
    const run = vi.spyOn(spec, "run").mockResolvedValue(EMPTY);
    for (const other of TRIGGERS) {
      if (other !== spec) vi.spyOn(other, "run").mockResolvedValue(EMPTY);
    }
    const outcomes = await runDueTriggers({ ignoreApprovalRate: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(outcomes.find((o) => o.name === NAME)?.fired).toBe(true);
  });

  it("without a retry time the interval still decides", async () => {
    seed({ last_polled_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    const run = vi.spyOn(spec, "run").mockResolvedValue(EMPTY);
    for (const other of TRIGGERS) {
      if (other !== spec) vi.spyOn(other, "run").mockResolvedValue(EMPTY);
    }
    await runDueTriggers({ ignoreApprovalRate: true });
    expect(run).not.toHaveBeenCalled();
  });
});
