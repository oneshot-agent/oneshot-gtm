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

describe("runDueTriggers — branch coverage (no claim attempt for these)", () => {
  it("does NOT attempt the claim when the trigger is disabled", async () => {
    // Disable everything.
    for (const key of Object.keys(fakeStore)) {
      const row = fakeStore[key];
      if (row) row.enabled = 0;
    }
    markReturnsTrue = false;
    await runDueTriggers();
    expect(calls.markTriggerRunning).toEqual([]);
    expect(calls.updateTriggerLastPoll).toEqual([]);
    // No skipped events either — disabled triggers exit silently before
    // reaching the readiness/claim/run path.
    const skipReasons = calls.events
      .filter((e) => e.kind === "trigger.run.skipped")
      .map((e) => e.ctx["reason"]);
    expect(skipReasons).not.toContain("already-running");
  });

  it("does NOT attempt the claim when the trigger was polled within its interval", async () => {
    // Set last_polled_at to "just now" so dueAt > now for all triggers.
    const justNow = new Date().toISOString();
    for (const row of Object.values(fakeStore)) {
      row.last_polled_at = justNow;
    }
    markReturnsTrue = false;
    await runDueTriggers();
    expect(calls.markTriggerRunning).toEqual([]);
  });

  it("does NOT attempt the claim when readiness blocks the trigger (config missing)", async () => {
    // github-topics requires `topics` in config (per its readiness fn). Its
    // defaultConfig in the registry has empty topics, so it should skip on
    // readiness BEFORE the claim. Confirm at least one such skip exists and
    // that markTriggerRunning was NOT called for it.
    markReturnsTrue = false;
    await runDueTriggers();
    const readinessSkips = calls.events.filter(
      (e) =>
        e.kind === "trigger.run.skipped" &&
        e.ctx["reason"] !== "already-running" &&
        e.ctx["source"] === "watch",
    );
    if (readinessSkips.length === 0) {
      // If no trigger has a default-blocked readiness, nothing to assert.
      return;
    }
    for (const skip of readinessSkips) {
      const blockedName = skip.ctx["name"] as string;
      const claimed = calls.markTriggerRunning.find((c) => c.name === blockedName);
      expect(claimed).toBeUndefined();
    }
  });
});

describe("runDueTriggers — corrupt config_json", () => {
  it("survives a corrupt row: falls back to defaults with a warning, other triggers still process", async () => {
    const corruptRow = fakeStore["show-hn"];
    if (!corruptRow) throw new Error("show-hn row missing — registry shape changed");
    corruptRow.config_json = "{definitely not json";

    markReturnsTrue = false;
    // Pre-fix, the bare JSON.parse threw out of the loop and rejected the
    // whole tick — every trigger stopped firing until the row was hand-fixed.
    const outcomes = await runDueTriggers();

    // The tick completed and produced an outcome for every registered trigger.
    expect(outcomes.length).toBe(TRIGGERS.length);
    // The corrupt one fell back to defaultConfig and still reached the claim.
    expect(calls.markTriggerRunning.some((c) => c.name === "show-hn")).toBe(true);
    // And the corruption was surfaced as a warning event.
    const warn = calls.events.find(
      (e) => e.kind === "trigger.config.corrupt" && e.ctx["name"] === "show-hn",
    );
    expect(warn).toBeDefined();
  });
});

describe("runDueTriggers — happy path (claim succeeds → finder runs)", () => {
  it("invokes spec.run, persists the result via updateTriggerLastPoll, emits trigger.run.done", async () => {
    // Pick the cheapest+fastest spec to mock — breakup-revive has no SDK calls.
    const spec = TRIGGERS.find((s) => s.name === "show-hn");
    if (!spec) throw new Error("show-hn spec missing — registry shape changed");

    // Disable every other trigger so we only exercise the chosen one.
    for (const row of Object.values(fakeStore)) {
      if (row.name !== spec.name) row.enabled = 0;
    }

    // Stub spec.run to a resolved FinderResult — we don't want to touch
    // the real ledger or any SDK.
    const fakeResult = {
      source: "find:show-hn",
      candidates: 3,
      droppedIcp: 0,
      droppedDuplicate: 1,
      droppedEnrichment: 0,
      enqueued: 2,
      costUsd: 0,
    };
    const runSpy = vi.spyOn(spec, "run").mockResolvedValue(fakeResult);

    markReturnsTrue = true;
    const outcomes = await runDueTriggers();

    try {
      expect(runSpy).toHaveBeenCalledTimes(1);
      // Exactly one claim for our spec.
      const claim = calls.markTriggerRunning.find((c) => c.name === spec.name);
      expect(claim).toBeDefined();
      // updateTriggerLastPoll called with our spec — clears running_started_at.
      expect(calls.updateTriggerLastPoll).toContain(spec.name);
      // Outcome reflects the result.
      const outcome = outcomes.find((o) => o.name === spec.name);
      expect(outcome).toMatchObject({ name: spec.name, fired: true });
      // trigger.run.done event emitted with our metrics.
      const done = calls.events.find(
        (e) => e.kind === "trigger.run.done" && e.ctx["name"] === spec.name,
      );
      expect(done).toBeDefined();
      expect(done!.ctx["enqueued"]).toBe(2);
      expect(done!.ctx["candidates"]).toBe(3);
      // No skipped event for this trigger.
      const skip = calls.events.find(
        (e) => e.kind === "trigger.run.skipped" && e.ctx["name"] === spec.name,
      );
      expect(skip).toBeUndefined();
    } finally {
      runSpy.mockRestore();
    }
  });

  it("when spec.run throws, persists an error summary and emits trigger.run.error", async () => {
    const spec = TRIGGERS.find((s) => s.name === "show-hn");
    if (!spec) throw new Error("show-hn spec missing — registry shape changed");

    for (const row of Object.values(fakeStore)) {
      if (row.name !== spec.name) row.enabled = 0;
    }

    const runSpy = vi.spyOn(spec, "run").mockRejectedValue(new Error("ledger boom"));

    markReturnsTrue = true;
    const outcomes = await runDueTriggers();

    try {
      expect(runSpy).toHaveBeenCalledTimes(1);
      // updateTriggerLastPoll still called — cleanup runs even on error,
      // which is what clears running_started_at.
      expect(calls.updateTriggerLastPoll).toContain(spec.name);
      // Outcome is fired:true with an error message.
      const outcome = outcomes.find((o) => o.name === spec.name);
      expect(outcome).toMatchObject({ name: spec.name, fired: true });
      expect(outcome!.error).toContain("ledger boom");
      // Error event emitted, not done.
      const errorEvent = calls.events.find(
        (e) => e.kind === "trigger.run.error" && e.ctx["name"] === spec.name,
      );
      expect(errorEvent).toBeDefined();
      const doneEvent = calls.events.find(
        (e) => e.kind === "trigger.run.done" && e.ctx["name"] === spec.name,
      );
      expect(doneEvent).toBeUndefined();
    } finally {
      runSpy.mockRestore();
    }
  });
});
