import { describe, expect, it } from "vitest";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { buildSignalDays } from "../src/lib/signalDays.ts";

function row(foundAt: string): QueueRowView {
  return {
    id: 1,
    playName: "show-hn",
    payload: null,
    dedupeKey: "k",
    source: "find:show-hn",
    status: "pending",
    foundAt,
    reviewedAt: null,
    sentAt: null,
    notes: null,
    prospectId: null,
  };
}

// All cases pin `now` so the bucketing math is reproducible regardless of
// when the test runs. Use a mid-day local time well clear of midnight to
// avoid edge-of-day ambiguity in the boundary tests.
const NOW = new Date(2026, 3, 25, 14, 42, 0); // Apr 25 (month is 0-indexed) 14:42 local

describe("buildSignalDays — shape", () => {
  it("returns exactly 7 buckets, oldest first", () => {
    const days = buildSignalDays([], NOW);
    expect(days).toHaveLength(7);
    // Each successive bucket starts 24h (or close, modulo DST) after the previous.
    for (let i = 1; i < 7; i++) {
      expect(days[i]!.startMs).toBeGreaterThan(days[i - 1]!.startMs);
    }
  });

  it("the last bucket is today (local-day-aligned)", () => {
    const days = buildSignalDays([], NOW);
    const expectedTodayStart = new Date(2026, 3, 25, 0, 0, 0, 0).getTime();
    expect(days[6]!.startMs).toBe(expectedTodayStart);
  });

  it("the first bucket is exactly 6 days before today", () => {
    const days = buildSignalDays([], NOW);
    const expectedFirstStart = new Date(2026, 3, 19, 0, 0, 0, 0).getTime();
    expect(days[0]!.startMs).toBe(expectedFirstStart);
  });
});

describe("buildSignalDays — calendar-day bucketing (the bug fix)", () => {
  // The previous Math.floor((now - ts) / 24h) version put yesterday-evening
  // rows into the "today" bucket. Each of these cases would have failed
  // before the fix.
  it("a row from 20h ago lands in YESTERDAY's bucket, not today's", () => {
    // NOW is Apr 25 14:42; 20h before is Apr 24 18:42.
    const days = buildSignalDays([row(new Date(2026, 3, 24, 18, 42, 0).toISOString())], NOW);
    expect(days[6]!.count).toBe(0); // today
    expect(days[5]!.count).toBe(1); // yesterday
  });

  it("a row from 1h ago lands in TODAY's bucket", () => {
    const days = buildSignalDays([row(new Date(2026, 3, 25, 13, 42, 0).toISOString())], NOW);
    expect(days[6]!.count).toBe(1);
    expect(days[5]!.count).toBe(0);
  });

  it("a row from just past midnight today lands in TODAY", () => {
    const days = buildSignalDays([row(new Date(2026, 3, 25, 0, 0, 1).toISOString())], NOW);
    expect(days[6]!.count).toBe(1);
  });

  it("a row from just before midnight yesterday lands in YESTERDAY", () => {
    const days = buildSignalDays([row(new Date(2026, 3, 24, 23, 59, 59).toISOString())], NOW);
    expect(days[5]!.count).toBe(1);
    expect(days[6]!.count).toBe(0);
  });

  it("rows older than 6 days are excluded from all buckets", () => {
    // Apr 18 — 7 days back, outside the 7-day window
    const days = buildSignalDays([row(new Date(2026, 3, 18, 12, 0, 0).toISOString())], NOW);
    expect(days.reduce((s, d) => s + d.count, 0)).toBe(0);
  });

  it("a row exactly at the cutoff (6 days ago, midnight) is included in bucket 0", () => {
    const days = buildSignalDays([row(new Date(2026, 3, 19, 0, 0, 0).toISOString())], NOW);
    expect(days[0]!.count).toBe(1);
  });
});

describe("buildSignalDays — multi-row aggregation", () => {
  it("counts each row in exactly one bucket", () => {
    const days = buildSignalDays(
      [
        row(new Date(2026, 3, 25, 9, 0, 0).toISOString()), // today
        row(new Date(2026, 3, 25, 13, 0, 0).toISOString()), // today
        row(new Date(2026, 3, 24, 18, 0, 0).toISOString()), // yesterday
        row(new Date(2026, 3, 22, 11, 0, 0).toISOString()), // 3 days ago
      ],
      NOW,
    );
    expect(days[6]!.count).toBe(2);
    expect(days[5]!.count).toBe(1);
    expect(days[3]!.count).toBe(1);
    expect(days.reduce((s, d) => s + d.count, 0)).toBe(4);
  });

  it("ignores rows with malformed foundAt", () => {
    const days = buildSignalDays(
      [
        row(new Date(2026, 3, 25, 9, 0, 0).toISOString()), // today
        row("definitely not a date"),
        row("2026-15-99"),
      ],
      NOW,
    );
    expect(days[6]!.count).toBe(1);
    expect(days.reduce((s, d) => s + d.count, 0)).toBe(1);
  });

  it("returns zero counts for the empty input", () => {
    const days = buildSignalDays([], NOW);
    expect(days.every((d) => d.count === 0)).toBe(true);
  });
});
