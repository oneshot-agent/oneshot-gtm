import { describe, expect, it } from "vitest";
import {
  cohortDemoDay,
  cohortDemoDayMonth,
  demoDayLine,
  demoDayOf,
  mentionsStaleDemoDay,
} from "../src/demo-day.ts";

const on = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("cohortDemoDayMonth", () => {
  it("maps each YC season to its demo-day month", () => {
    expect(cohortDemoDayMonth("yc-w26")).toBe("2026-03");
    expect(cohortDemoDayMonth("yc-p26")).toBe("2026-06");
    expect(cohortDemoDayMonth("yc-x25")).toBe("2025-06");
    expect(cohortDemoDayMonth("yc-s26")).toBe("2026-09");
    expect(cohortDemoDayMonth("yc-f25")).toBe("2025-12");
    expect(cohortDemoDayMonth("YC W26")).toBe("2026-03");
  });

  it("knows nothing about accelerators without a fixed public schedule", () => {
    for (const id of ["antler-2026", "techstars-2026", "spc-2026-1", "a16z-speedrun-2026", ""]) {
      expect(cohortDemoDayMonth(id)).toBeNull();
    }
    expect(cohortDemoDayMonth(null)).toBeNull();
  });
});

describe("cohortDemoDay", () => {
  it("judges passed, this month and upcoming against now", () => {
    expect(cohortDemoDay("yc-w26", on("2026-09-25"))).toEqual({
      month: "March 2026",
      isoMonth: "2026-03",
      status: "passed",
      monthsAway: 6,
    });
    expect(cohortDemoDay("yc-s26", on("2026-09-25"))?.status).toBe("this month");
    expect(cohortDemoDay("yc-f26", on("2026-09-25"))).toMatchObject({
      status: "upcoming",
      monthsAway: 3,
    });
  });

  it("counts across a year boundary", () => {
    expect(cohortDemoDay("yc-f25", on("2026-01-15"))).toMatchObject({
      month: "December 2025",
      status: "passed",
      monthsAway: 1,
    });
    expect(cohortDemoDay("yc-w27", on("2026-11-02"))).toMatchObject({
      month: "March 2027",
      status: "upcoming",
      monthsAway: 4,
    });
  });
});

describe("demoDayOf", () => {
  it("prefers a stamped month, else the cohort id", () => {
    expect(demoDayOf({ demoDayMonth: "2026-04", cohort: "yc-w26" }, on("2026-09-01"))?.month).toBe(
      "April 2026",
    );
    expect(demoDayOf({ cohort: "yc-w26" }, on("2026-09-01"))?.month).toBe("March 2026");
    expect(demoDayOf({ demoDayMonth: "garbage", cohort: "yc-w26" }, on("2026-09-01"))?.month).toBe(
      "March 2026",
    );
    expect(demoDayOf({ cohort: "antler-2026" })).toBeNull();
    expect(demoDayOf(null)).toBeNull();
  });
});

describe("demoDayLine", () => {
  it("renders each status, and nothing when unknown", () => {
    const now = on("2026-09-25");
    expect(demoDayLine(cohortDemoDay("yc-w26", now))).toBe(
      "DEMO DAY: March 2026 (passed, ~6 months ago)",
    );
    expect(demoDayLine(cohortDemoDay("yc-s26", now))).toBe("DEMO DAY: September 2026 (this month)");
    expect(demoDayLine(cohortDemoDay("yc-f26", now))).toBe(
      "DEMO DAY: December 2026 (upcoming, in ~3 months)",
    );
    expect(demoDayLine(cohortDemoDay("yc-w26", on("2026-02-02")))).toBe(
      "DEMO DAY: March 2026 (upcoming, in ~1 month)",
    );
    expect(demoDayLine(null)).toBeNull();
  });
});

describe("mentionsStaleDemoDay", () => {
  const now = on("2026-09-25");
  it("holds any mention once demo day has passed", () => {
    const passed = cohortDemoDay("yc-w26", now);
    expect(mentionsStaleDemoDay("Numbers for demo day?", passed)).toBe(true);
    expect(mentionsStaleDemoDay("before Demo-Day hits", passed)).toBe(true);
    expect(mentionsStaleDemoDay("Are you logging replies?", passed)).toBe(false);
  });

  it("never fires when demo day is ahead or unknown", () => {
    expect(mentionsStaleDemoDay("Numbers for demo day?", cohortDemoDay("yc-f26", now))).toBe(false);
    expect(mentionsStaleDemoDay("Numbers for demo day?", null)).toBe(false);
  });
});
