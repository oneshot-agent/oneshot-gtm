import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeUtcIso, timeAgo } from "../src/lib/cn.ts";

/**
 * Locks in the fix for the UTC-no-marker bug: SQLite's `datetime('now')`
 * returns "YYYY-MM-DD HH:MM:SS" without a Z, which JavaScript's `new Date()`
 * interprets as LOCAL time. In any non-UTC timezone, every receipt /
 * sequence_event / queue row was displaying with a tz-offset shift. The
 * normalizeUtcIso helper appends "Z" so the parse is unambiguous; ISO
 * strings that already carry a Z pass through.
 */

describe("normalizeUtcIso", () => {
  it("appends Z to SQLite's UTC-no-marker format", () => {
    expect(normalizeUtcIso("2026-06-06 22:00:00")).toBe("2026-06-06 22:00:00Z");
  });

  it("passes ISO-with-Z through unchanged", () => {
    expect(normalizeUtcIso("2026-06-06T22:00:00Z")).toBe("2026-06-06T22:00:00Z");
  });

  it("passes ISO-with-fractional-seconds-and-Z through unchanged", () => {
    expect(normalizeUtcIso("2026-06-06T22:00:00.123Z")).toBe("2026-06-06T22:00:00.123Z");
  });

  it("passes ISO-with-offset through unchanged", () => {
    expect(normalizeUtcIso("2026-06-06T22:00:00+02:00")).toBe("2026-06-06T22:00:00+02:00");
  });

  it("doesn't mangle a date-only string (just returns it as-is)", () => {
    // Date-only is unlikely in our pipeline but harmless to leave alone.
    expect(normalizeUtcIso("2026-06-06")).toBe("2026-06-06");
  });
});

describe("timeAgo", () => {
  // Pin the wall clock so age calculations are deterministic.
  const NOW = new Date("2026-06-06T22:00:00Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns — for null", () => {
    expect(timeAgo(null)).toBe("—");
  });

  it("treats SQLite's UTC-no-marker format as UTC (the bug)", () => {
    // 5 minutes before NOW, expressed in SQLite-flat format.
    expect(timeAgo("2026-06-06 21:55:00")).toBe("5m ago");
  });

  it("treats ISO-with-Z as UTC (same age as the SQLite-flat version)", () => {
    expect(timeAgo("2026-06-06T21:55:00Z")).toBe("5m ago");
  });

  it("a row from 0 seconds ago renders as 0s ago", () => {
    expect(timeAgo("2026-06-06 22:00:00")).toBe("0s ago");
  });

  it("renders hours and days correctly", () => {
    expect(timeAgo("2026-06-06 19:00:00")).toBe("3h ago");
    expect(timeAgo("2026-06-04 22:00:00")).toBe("2d ago");
  });

  // Locks in the fix for the "in 150983s" /cadences NEXT DUE bug. timeAgo
  // used to format future deltas as raw seconds with an "in Ns" suffix; now
  // it cascades through minutes/hours/days the same way past deltas do.
  it("cascades future deltas through minutes / hours / days like past ones", () => {
    expect(timeAgo("2026-06-06 22:00:30")).toBe("in 30s");
    expect(timeAgo("2026-06-06 22:05:00")).toBe("in 5m");
    expect(timeAgo("2026-06-07 01:00:00")).toBe("in 3h");
    // The actual /cadences case: ~42h in the future renders as "in 1d", not "in 150983s".
    expect(timeAgo("2026-06-08 16:00:00")).toBe("in 1d");
  });
});
