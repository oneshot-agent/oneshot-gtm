import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRow {
  name: string;
  enabled: number;
  config_json: string;
  last_polled_at: string | null;
  running_started_at: string | null;
}

const fakeStore: Record<string, FakeRow> = {};
const calls = {
  markTriggerRunning: [] as Array<{ name: string; nowIso: string; staleCutoffIso?: string }>,
  updateTriggerLastPoll: [] as string[],
  events: [] as Array<{ kind: string; ctx: Record<string, unknown> }>,
};
let markReturnsTrue = false;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: (kind: string, ctx?: Record<string, unknown>) => {
      calls.events.push({ kind, ctx: ctx ?? {} });
    },
    startRun: () => {},
    getLedger: () => ({
      getTrigger: (name: string): FakeRow | undefined => fakeStore[name],
      upsertTrigger: (input: { name: string; configJson: string; enabled?: boolean }) => {
        fakeStore[input.name] = {
          name: input.name,
          enabled: input.enabled === false ? 0 : 1,
          config_json: input.configJson,
          last_polled_at: null,
          running_started_at: null,
        };
      },
      markTriggerRunning: (name: string, nowIso: string, staleCutoffIso?: string): boolean => {
        const entry: { name: string; nowIso: string; staleCutoffIso?: string } = { name, nowIso };
        if (staleCutoffIso !== undefined) entry.staleCutoffIso = staleCutoffIso;
        calls.markTriggerRunning.push(entry);
        return markReturnsTrue;
      },
      updateTriggerLastPoll: (input: { name: string }) => {
        calls.updateTriggerLastPoll.push(input.name);
      },
      // Methods downstream finders might call — only invoked on claim success,
      // which we deliberately disable in these tests, so no-op stubs suffice.
      isQueueDuplicate: () => false,
      enqueueTarget: () => 0,
      findProspectByEmail: () => null,
      recordReceipt: () => 0,
    }),
  };
});

const { runDueTriggers, TRIGGERS } = await import("../src/registry.ts");

beforeEach(() => {
  for (const k of Object.keys(fakeStore)) delete fakeStore[k];
  calls.markTriggerRunning = [];
  calls.updateTriggerLastPoll = [];
  calls.events = [];
  markReturnsTrue = false;

  // Pre-seed an enabled, never-polled (so always-due) row for every spec
  // that's enabledByDefault. Skip opt-in triggers so they don't gate-check.
  for (const spec of TRIGGERS) {
    if (spec.enabledByDefault === false) continue;
    fakeStore[spec.name] = {
      name: spec.name,
      enabled: 1,
      config_json: JSON.stringify(spec.defaultConfig),
      last_polled_at: null,
      running_started_at: null,
    };
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runDueTriggers — atomic claim", () => {
  it("calls markTriggerRunning before invoking the finder", async () => {
    markReturnsTrue = false;
    await runDueTriggers();
    // Every enabled+due trigger must have attempted a claim.
    expect(calls.markTriggerRunning.length).toBeGreaterThan(0);
    // None of them updated last_poll because none actually ran the finder.
    expect(calls.updateTriggerLastPoll).toEqual([]);
  });

  it("skips the finder + emits trigger.run.skipped when the claim fails", async () => {
    markReturnsTrue = false;
    const outcomes = await runDueTriggers();
    // All due triggers report fired:false because the claim was lost.
    for (const o of outcomes) {
      // Some triggers may be readiness-blocked (e.g. github-topics without
      // topics in defaultConfig) — those skip BEFORE the claim. Filter them
      // out by looking only at triggers that attempted a claim.
      const attempted = calls.markTriggerRunning.some((c) => c.name === o.name);
      if (attempted) {
        expect(o.fired).toBe(false);
      }
    }
    // The skipped event carries the right reason + source label.
    const skips = calls.events.filter(
      (e) => e.kind === "trigger.run.skipped" && e.ctx["reason"] === "already-running",
    );
    expect(skips.length).toBe(calls.markTriggerRunning.length);
    for (const s of skips) {
      expect(s.ctx["source"]).toBe("watch");
    }
  });

  it("passes a staleCutoffIso so a 4h-stale row can be reclaimed", async () => {
    markReturnsTrue = false;
    await runDueTriggers();
    expect(calls.markTriggerRunning.length).toBeGreaterThan(0);
    for (const c of calls.markTriggerRunning) {
      expect(c.staleCutoffIso).toBeDefined();
      // staleCutoff is older than nowIso (it's `now - MAX_RUN_AGE_MS`).
      expect(new Date(c.staleCutoffIso!).getTime()).toBeLessThan(new Date(c.nowIso).getTime());
    }
  });
});
