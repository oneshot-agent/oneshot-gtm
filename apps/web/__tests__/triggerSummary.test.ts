import { describe, expect, it } from "vitest";
import type { TriggerView } from "@oneshot-gtm/shared-types";
import { dueInMs, summarizeTriggers } from "../src/lib/triggerSummary.ts";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const HOUR = 3_600_000;

function trigger(over: Partial<TriggerView> = {}): TriggerView {
  return {
    name: "show-hn",
    enabled: true,
    running: false,
    intervalMs: 6 * HOUR,
    defaultIntervalMs: 6 * HOUR,
    lastPolledAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  } as TriggerView;
}

describe("dueInMs", () => {
  it("counts forward from the last poll", () => {
    expect(dueInMs(trigger(), NOW)).toBe(5 * HOUR);
  });

  it("goes negative once a trigger is overdue", () => {
    const t = trigger({ lastPolledAt: new Date(NOW - 8 * HOUR).toISOString() });
    expect(dueInMs(t, NOW)).toBe(-2 * HOUR);
  });

  // The case the whole null branch exists for: `intervalMs - now()` would make
  // a never-polled trigger look about 57 years overdue.
  it("is null for a trigger that has never polled", () => {
    expect(dueInMs(trigger({ lastPolledAt: null }), NOW)).toBeNull();
  });

  it("is null while disabled, running, or not ready", () => {
    expect(dueInMs(trigger({ enabled: false }), NOW)).toBeNull();
    expect(dueInMs(trigger({ running: true }), NOW)).toBeNull();
    expect(dueInMs(trigger({ ready: false }), NOW)).toBeNull();
  });

  // Older servers omit `ready` entirely, and absent means ready — the same
  // rule the trigger row applies when it decides whether to grey out `run now`.
  it("treats an absent ready field as ready", () => {
    expect(dueInMs(trigger({ ready: undefined }), NOW)).toBe(5 * HOUR);
  });
});

describe("summarizeTriggers", () => {
  it("counts what the collapsed header prints", () => {
    const s = summarizeTriggers(
      [
        trigger({ name: "a" }),
        trigger({ name: "b", running: true }),
        trigger({ name: "c", ready: false }),
        trigger({ name: "d", enabled: false }),
        trigger({ name: "e", lastPolledAt: new Date(NOW - 9 * HOUR).toISOString() }),
      ],
      NOW,
    );
    expect(s).toEqual({
      enabled: 4,
      running: 1,
      notReady: 1,
      overdue: 1,
      nextDueMs: 5 * HOUR,
    });
  });

  it("reports no next tick when nothing is scheduled", () => {
    const s = summarizeTriggers([trigger({ enabled: false })], NOW);
    expect(s.nextDueMs).toBeNull();
    expect(s.enabled).toBe(0);
  });

  it("survives an empty list", () => {
    expect(summarizeTriggers([], NOW)).toEqual({
      enabled: 0,
      running: 0,
      notReady: 0,
      overdue: 0,
      nextDueMs: null,
    });
  });
});
