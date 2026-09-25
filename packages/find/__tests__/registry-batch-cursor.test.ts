import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies the registry stamps `_triggerBatchSeq` (companyBatchCursorFor's
// input) from the trigger's PRE-run `company_batch_seq` before invoking
// `spec.run`, for both the `runTriggerNow` (ad-hoc/"Run now") and
// `runDueTriggers` (scheduled watch loop) paths — issue #708's rotation
// cursor. `company_batch_seq` is a monotonic per-trigger counter (not the
// `last_polled_at` wall-clock timestamp) so that `cursor mod batchCount`
// advances by exactly one index every completed run and cannot repeat the
// same starting batch on two successive runs, unlike an epoch-ms cursor
// whose value modulo the batch count can coincide. Mirrors
// registry-claim.test.ts's mocking pattern (fake ledger store + `spec.run`
// spy) rather than exercising a real finder.

interface FakeRow {
  name: string;
  enabled: number;
  config_json: string;
  last_polled_at: string | null;
  running_started_at: string | null;
  company_batch_seq: number;
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
      upsertTrigger: (input: { name: string; configJson: string; enabled?: boolean }) => {
        fakeStore[input.name] = {
          name: input.name,
          enabled: input.enabled === false ? 0 : 1,
          config_json: input.configJson,
          last_polled_at: null,
          running_started_at: null,
          company_batch_seq: 0,
        };
      },
      markTriggerRunning: (name: string): boolean => {
        const row = fakeStore[name];
        if (row) row.running_started_at = new Date().toISOString();
        return true;
      },
      updateTriggerLastPoll: (input: { name: string }) => {
        const row = fakeStore[input.name];
        if (row) {
          row.running_started_at = null;
          row.last_polled_at = new Date().toISOString();
          row.company_batch_seq += 1;
        }
      },
      clearTriggerClaim: (input: { name: string }) => {
        const row = fakeStore[input.name];
        if (row) row.running_started_at = null;
      },
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

const { runTriggerNow, runDueTriggers, TRIGGERS } = await import("../src/registry.ts");

const HIRING_SIGNAL_CONFIG = {
  companies: ["Acme"],
  yourClaim: "we cut onboarding time in half",
  sinceDays: 14,
  limit: 25,
  maxCostUsd: 5,
};

beforeEach(() => {
  for (const k of Object.keys(fakeStore)) delete fakeStore[k];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("companyBatchCursor wiring (#708)", () => {
  it("runTriggerNow passes the PRE-run company_batch_seq as companyBatchCursor", async () => {
    const spec = TRIGGERS.find((s) => s.name === "hiring-signal");
    if (!spec) throw new Error("hiring-signal spec missing — registry shape changed");

    fakeStore["hiring-signal"] = {
      name: "hiring-signal",
      enabled: 1,
      config_json: JSON.stringify(HIRING_SIGNAL_CONFIG),
      last_polled_at: "2026-01-01T00:00:00.000Z",
      running_started_at: null,
      company_batch_seq: 7,
    };

    const runSpy = vi.spyOn(spec, "run").mockResolvedValue({
      source: "find:hiring-signal",
      candidates: 0,
      droppedIcp: 0,
      droppedDuplicate: 0,
      droppedEnrichment: 0,
      enqueued: 0,
      costUsd: 0,
    });

    try {
      await runTriggerNow("hiring-signal");
      expect(runSpy).toHaveBeenCalledTimes(1);
      const passedConfig = runSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(passedConfig["_triggerBatchSeq"]).toBe(7);
    } finally {
      runSpy.mockRestore();
    }
  });

  it("runTriggerNow defaults the cursor to 0 for a never-run trigger", async () => {
    const spec = TRIGGERS.find((s) => s.name === "job-change");
    if (!spec) throw new Error("job-change spec missing — registry shape changed");

    fakeStore["job-change"] = {
      name: "job-change",
      enabled: 1,
      config_json: JSON.stringify({
        companies: ["Acme"],
        yourEdge: "we cut onboarding time in half",
      }),
      last_polled_at: null,
      running_started_at: null,
      company_batch_seq: 0,
    };

    const runSpy = vi.spyOn(spec, "run").mockResolvedValue({
      source: "find:job-change",
      candidates: 0,
      droppedIcp: 0,
      droppedDuplicate: 0,
      droppedEnrichment: 0,
      enqueued: 0,
      costUsd: 0,
    });

    try {
      await runTriggerNow("job-change");
      const passedConfig = runSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(passedConfig["_triggerBatchSeq"]).toBe(0);
    } finally {
      runSpy.mockRestore();
    }
  });

  it("does not leak the cursor key onto spec.defaultConfig (no stored row yet)", async () => {
    const spec = TRIGGERS.find((s) => s.name === "hiring-signal");
    if (!spec) throw new Error("hiring-signal spec missing — registry shape changed");
    expect(spec.defaultConfig["_triggerBatchSeq"]).toBeUndefined();

    // No fakeStore row — runTriggerNow bootstraps one from spec.defaultConfig,
    // exercising the `storedTriggerConfig` "return the default object itself"
    // path this guard protects.
    const runSpy = vi.spyOn(spec, "run").mockImplementation(async (cfg) => {
      // yourClaim is required for readiness — the bootstrap uses defaultConfig,
      // which has no yourClaim, so this branch is only reachable once we set
      // the row up manually below. Kept as a type-correct no-op fallback.
      void cfg;
      return {
        source: "find:hiring-signal",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      };
    });

    try {
      // Give the not-ready default config a readiness pass by pre-seeding a
      // row that mirrors defaultConfig plus the required yourClaim — this is
      // what "no stored row yet" would upsert if readiness passed.
      fakeStore["hiring-signal"] = {
        name: "hiring-signal",
        enabled: 1,
        config_json: JSON.stringify({ ...spec.defaultConfig, yourClaim: "a claim" }),
        last_polled_at: null,
        running_started_at: null,
        company_batch_seq: 0,
      };
      await runTriggerNow("hiring-signal");
      expect(spec.defaultConfig["_triggerBatchSeq"]).toBeUndefined();
    } finally {
      runSpy.mockRestore();
    }
  });

  it("runDueTriggers passes the PRE-run company_batch_seq as companyBatchCursor", async () => {
    const spec = TRIGGERS.find((s) => s.name === "job-change");
    if (!spec) throw new Error("job-change spec missing — registry shape changed");

    // Interval is 24h; set last_polled_at far enough in the past that the
    // trigger is due.
    const priorPollIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fakeStore["job-change"] = {
      name: "job-change",
      enabled: 1,
      config_json: JSON.stringify({
        companies: ["Acme"],
        yourEdge: "we cut onboarding time in half",
      }),
      last_polled_at: priorPollIso,
      running_started_at: null,
      company_batch_seq: 3,
    };
    // Disable every other trigger so only job-change runs.
    for (const other of TRIGGERS) {
      if (other.name === "job-change") continue;
      fakeStore[other.name] = {
        name: other.name,
        enabled: 0,
        config_json: JSON.stringify(other.defaultConfig),
        last_polled_at: null,
        running_started_at: null,
        company_batch_seq: 0,
      };
    }

    const runSpy = vi.spyOn(spec, "run").mockResolvedValue({
      source: "find:job-change",
      candidates: 0,
      droppedIcp: 0,
      droppedDuplicate: 0,
      droppedEnrichment: 0,
      enqueued: 0,
      costUsd: 0,
    });

    try {
      await runDueTriggers();
      expect(runSpy).toHaveBeenCalledTimes(1);
      const passedConfig = runSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(passedConfig["_triggerBatchSeq"]).toBe(3);
    } finally {
      runSpy.mockRestore();
    }
  });

  it("advances by exactly 1 across two successive completed runs, never repeating the start batch", async () => {
    const spec = TRIGGERS.find((s) => s.name === "hiring-signal");
    if (!spec) throw new Error("hiring-signal spec missing — registry shape changed");

    fakeStore["hiring-signal"] = {
      name: "hiring-signal",
      enabled: 1,
      config_json: JSON.stringify(HIRING_SIGNAL_CONFIG),
      last_polled_at: "2026-01-01T00:00:00.000Z",
      running_started_at: null,
      company_batch_seq: 0,
    };

    const cursors: number[] = [];
    const runSpy = vi.spyOn(spec, "run").mockImplementation(async (cfg) => {
      cursors.push((cfg as Record<string, unknown>)["_triggerBatchSeq"] as number);
      return {
        source: "find:hiring-signal",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      };
    });

    try {
      // Two runs back-to-back — with the old epoch-ms cursor these could
      // land in the same millisecond (or otherwise share a residue mod
      // batchCount); the counter guarantees they never do.
      await runTriggerNow("hiring-signal");
      await runTriggerNow("hiring-signal");
      expect(cursors).toEqual([0, 1]);
    } finally {
      runSpy.mockRestore();
    }
  });
});
