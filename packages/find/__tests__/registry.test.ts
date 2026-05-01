import { describe, expect, it } from "vitest";
import {
  checkReadiness,
  effectiveIntervalMs,
  freshRunningStartedAtMs,
  MAX_RUN_AGE_MS,
  nextSleepMs,
  TRIGGERS,
  type TriggerRunOutcome,
  type TriggerSpec,
} from "../src/registry.ts";

describe("nextSleepMs", () => {
  it("defaults to 1h when there are no outcomes", () => {
    expect(nextSleepMs([])).toBe(60 * 60 * 1000);
  });

  it("floors at 60s when a trigger is overdue (negative nextDueInMs)", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: true, nextDueInMs: -5_000 },
      { name: "b", fired: false, nextDueInMs: 10 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(60_000);
  });

  it("ceilings at 1h even when the next-due is far in the future", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: false, nextDueInMs: 24 * 60 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(60 * 60 * 1000);
  });

  it("returns the smallest nextDueInMs inside the [60s, 1h] window", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: false, nextDueInMs: 10 * 60 * 1000 },
      { name: "b", fired: false, nextDueInMs: 5 * 60 * 1000 },
      { name: "c", fired: false, nextDueInMs: 30 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(5 * 60 * 1000);
  });
});

describe("TRIGGERS registry", () => {
  it("exposes the expected built-in triggers", () => {
    const names = TRIGGERS.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "accelerator-batch",
      "breakup-revive",
      "github-topics",
      "hiring-signal",
      "job-change",
      "podcast-guest",
      "post-funding-auto",
      "show-hn",
    ]);
  });

  it("each trigger has a positive default interval and a run function", () => {
    for (const t of TRIGGERS) {
      expect(t.defaultIntervalMs).toBeGreaterThan(0);
      expect(typeof t.run).toBe("function");
      expect(t.defaultConfig).toBeTypeOf("object");
    }
  });

  it("opt-in triggers are disabled by default", () => {
    const optIn = [
      "job-change",
      "hiring-signal",
      "podcast-guest",
      "breakup-revive",
      "github-topics",
      "accelerator-batch",
    ];
    for (const name of optIn) {
      const spec = TRIGGERS.find((t) => t.name === name);
      expect(spec?.enabledByDefault, `${name} should be opt-in`).toBe(false);
    }
  });
});

describe("checkReadiness", () => {
  it("returns ready:true for specs without a readiness fn", () => {
    const spec: TriggerSpec = {
      name: "noop",
      defaultIntervalMs: 60_000,
      defaultConfig: {},
      run: async () => ({
        source: "test",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      }),
    };
    expect(checkReadiness(spec, {})).toEqual({ ready: true });
  });

  it("returns the spec's readiness verdict when a fn is declared", () => {
    const spec: TriggerSpec = {
      name: "gated",
      defaultIntervalMs: 60_000,
      defaultConfig: { token: "" },
      readiness: (cfg) =>
        typeof cfg["token"] === "string" && cfg["token"].length > 0
          ? { ready: true }
          : { ready: false, reason: "token missing" },
      run: async () => ({
        source: "test",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      }),
    };
    expect(checkReadiness(spec, { token: "" })).toEqual({ ready: false, reason: "token missing" });
    expect(checkReadiness(spec, { token: "abc" })).toEqual({ ready: true });
  });

  it("treats a throwing readiness fn as not-ready rather than crashing the caller", () => {
    const spec: TriggerSpec = {
      name: "boom",
      defaultIntervalMs: 60_000,
      defaultConfig: {},
      readiness: () => {
        throw new Error("unexpected");
      },
      run: async () => ({
        source: "test",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      }),
    };
    const out = checkReadiness(spec, {});
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/threw/);
  });

  it("github-topics is not ready with its empty default config (topics required first)", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    expect(spec.readiness).toBeDefined();
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/topics/);
  });

  it("github-topics is not ready when vendors is empty even with topics set", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: ["llm-agents"],
      vendors: [],
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/vendors/);
  });

  it("github-topics is not ready when yourEdge is blank/whitespace", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: ["llm-agents"],
      vendors: ["langchain"],
      yourEdge: "  \t\n  ",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("github-topics becomes ready with topics, vendors, and yourEdge set", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: ["llm-agents", "ai-agent"],
      vendors: ["langchain", "openai"],
      yourEdge: "one SDK instead of six dependencies",
    });
    expect(out).toEqual({ ready: true });
  });

  it("every registered trigger is ready with its own default config (incl. opt-in declarers)", () => {
    // Regression guard. Most triggers ship ready out-of-the-box; ones that
    // require founder-supplied config (topics, etc.) ship unready by design
    // and are excluded here.
    const intentionallyUnreadyByDefault = new Set(["github-topics", "accelerator-batch"]);
    for (const spec of TRIGGERS) {
      if (intentionallyUnreadyByDefault.has(spec.name)) continue;
      expect(checkReadiness(spec, spec.defaultConfig), `${spec.name} should be ready`).toEqual({
        ready: true,
      });
    }
  });

  it("accelerator-batch is not ready when cohort is empty", () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch");
    expect(spec).toBeDefined();
    expect(spec!.readiness).toBeDefined();
    const out = checkReadiness(spec!, { ...spec!.defaultConfig, cohort: "" });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/cohort/);
  });

  it("accelerator-batch is ready with cohort + cohortLabel set", () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch")!;
    expect(checkReadiness(spec, { cohort: "yc-w26", cohortLabel: "YC W26" })).toEqual({
      ready: true,
    });
  });
});

describe("effectiveIntervalMs", () => {
  it("uses defaultIntervalMs when no override is supplied", () => {
    const spec = TRIGGERS[0]!;
    expect(effectiveIntervalMs(spec, null)).toBe(spec.defaultIntervalMs);
    expect(effectiveIntervalMs(spec, {})).toBe(spec.defaultIntervalMs);
  });

  it("honors a numeric intervalMs override", () => {
    const spec = TRIGGERS[0]!;
    expect(effectiveIntervalMs(spec, { intervalMs: 90_000 })).toBe(90_000);
  });

  it("ignores a too-small or non-numeric intervalMs", () => {
    const spec = TRIGGERS[0]!;
    expect(effectiveIntervalMs(spec, { intervalMs: 1000 })).toBe(spec.defaultIntervalMs);
    expect(effectiveIntervalMs(spec, { intervalMs: "fast" })).toBe(spec.defaultIntervalMs);
  });
});

describe("freshRunningStartedAtMs — freshness gate", () => {
  const NOW = new Date("2026-04-24T19:00:00Z").getTime();

  it("returns null for null/undefined/empty", () => {
    expect(freshRunningStartedAtMs(null, NOW)).toBeNull();
    expect(freshRunningStartedAtMs(undefined, NOW)).toBeNull();
    expect(freshRunningStartedAtMs("", NOW)).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(freshRunningStartedAtMs("not a date", NOW)).toBeNull();
  });

  it("returns the start epoch when the timestamp is fresh (within window)", () => {
    const startedAt = "2026-04-24T18:55:00Z"; // 5 min before NOW
    expect(freshRunningStartedAtMs(startedAt, NOW)).toBe(new Date(startedAt).getTime());
  });

  it("returns null when the timestamp exceeds MAX_RUN_AGE_MS", () => {
    // 5 hours before NOW — well outside the 4h window.
    const startedAt = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    expect(freshRunningStartedAtMs(startedAt, NOW)).toBeNull();
  });

  it("treats the boundary as fresh (==MAX_RUN_AGE_MS) — only > is stale", () => {
    const exact = NOW - MAX_RUN_AGE_MS;
    const justFresh = new Date(exact).toISOString();
    expect(freshRunningStartedAtMs(justFresh, NOW)).toBe(exact);
    const justStale = new Date(exact - 1).toISOString();
    expect(freshRunningStartedAtMs(justStale, NOW)).toBeNull();
  });

  it("returns the start epoch when the timestamp is in the future (clock skew)", () => {
    // We don't actively defend against future timestamps — better to keep
    // the row visible than to silently hide a real run.
    const future = new Date(NOW + 60_000).toISOString();
    expect(freshRunningStartedAtMs(future, NOW)).toBe(new Date(future).getTime());
  });
});
