import { describe, expect, it } from "vitest";
import type { TriggerRow } from "@oneshot-gtm/core";
import type { TriggerSpec } from "@oneshot-gtm/find";
import { toView } from "../src/api/triggers.ts";

const SPEC: TriggerSpec = {
  name: "show-hn",
  defaultIntervalMs: 6 * 60 * 60 * 1000,
  defaultConfig: { sinceDays: 1, limit: 25, maxCostUsd: 5 },
  run: async () => ({
    source: "find:show-hn",
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  }),
};

const OPT_IN_SPEC: TriggerSpec = {
  ...SPEC,
  name: "job-change",
  enabledByDefault: false,
};

function row(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    name: "show-hn",
    last_polled_at: null,
    last_run_summary: null,
    enabled: 1,
    config_json: JSON.stringify({ sinceDays: 1, limit: 25 }),
    ...overrides,
  };
}

describe("toView — fresh registry trigger (no stored row)", () => {
  it("uses the registry default config + default enabled when no row exists", () => {
    const v = toView(SPEC.name, SPEC.defaultIntervalMs, null, SPEC);
    expect(v.enabled).toBe(true);
    expect(v.defaultConfig).toEqual(SPEC.defaultConfig);
    expect(v.intervalMs).toBe(SPEC.defaultIntervalMs);
    expect(v.defaultIntervalMs).toBe(SPEC.defaultIntervalMs);
    expect(v.config).toBeNull();
    expect(v.lastPolledAt).toBeNull();
    expect(v.lastRunSummary).toBeNull();
  });

  it("opt-in triggers default to disabled when no row exists", () => {
    const v = toView(OPT_IN_SPEC.name, OPT_IN_SPEC.defaultIntervalMs, null, OPT_IN_SPEC);
    expect(v.enabled).toBe(false);
  });
});

describe("toView — stored row present", () => {
  it("reflects the row's enabled flag and stored config", () => {
    const v = toView(SPEC.name, SPEC.defaultIntervalMs, row({ enabled: 0 }), SPEC);
    expect(v.enabled).toBe(false);
    expect(v.config).toEqual({ sinceDays: 1, limit: 25 });
  });

  it("honors a config.intervalMs override when valid (≥ 60_000)", () => {
    const stored = row({ config_json: JSON.stringify({ intervalMs: 90_000 }) });
    const v = toView(SPEC.name, SPEC.defaultIntervalMs, stored, SPEC);
    expect(v.intervalMs).toBe(90_000);
  });

  it("ignores a too-small intervalMs override", () => {
    const stored = row({ config_json: JSON.stringify({ intervalMs: 1000 }) });
    const v = toView(SPEC.name, SPEC.defaultIntervalMs, stored, SPEC);
    expect(v.intervalMs).toBe(SPEC.defaultIntervalMs);
  });

  it("parses last_run_summary JSON, falling back to the raw string when invalid", () => {
    const good = row({ last_run_summary: JSON.stringify({ enqueued: 3 }) });
    expect(toView(SPEC.name, SPEC.defaultIntervalMs, good, SPEC).lastRunSummary).toEqual({
      enqueued: 3,
    });

    const bad = row({ last_run_summary: "not valid json" });
    expect(toView(SPEC.name, SPEC.defaultIntervalMs, bad, SPEC).lastRunSummary).toBe(
      "not valid json",
    );
  });

  it("treats invalid config_json as null config (doesn't crash)", () => {
    const stored = row({ config_json: "not valid json" });
    const v = toView(SPEC.name, SPEC.defaultIntervalMs, stored, SPEC);
    expect(v.config).toBeNull();
  });
});

describe("toView — orphan (row stored, spec removed from registry)", () => {
  it("returns a view so the founder can still disable it from /queue", () => {
    const stored = row({ name: "yc-w24", enabled: 1 });
    const v = toView("yc-w24", 24 * 60 * 60 * 1000, stored, null);
    expect(v.enabled).toBe(true);
    expect(v.defaultConfig).toBeNull();
    expect(v.intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});
