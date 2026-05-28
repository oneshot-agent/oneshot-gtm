import { describe, expect, it } from "vitest";
import { summarizeRun } from "../src/lib/summarizeRun.ts";

describe("summarizeRun", () => {
  it("returns '—' for null / undefined / non-object", () => {
    expect(summarizeRun(null)).toBe("—");
    expect(summarizeRun(undefined)).toBe("—");
    expect(summarizeRun("nope")).toBe("—");
    expect(summarizeRun(42)).toBe("—");
  });

  it("prioritizes error over everything", () => {
    expect(summarizeRun({ error: "boom", candidates: 10 })).toMatch(/^error: boom/);
  });

  it("prioritizes halted over counters", () => {
    expect(summarizeRun({ halted: "max-cost cap (5)", candidates: 10 })).toMatch(/^halted ·/);
  });

  it("formats the standard counter breakdown", () => {
    const out = summarizeRun({
      candidates: 12,
      enqueued: 4,
      droppedIcp: 6,
      costUsd: 0.42,
    });
    expect(out).toBe("cand=12 · kept=4 · icp=6 · $0.42");
  });

  it("omits droppedLowSignal when zero", () => {
    const out = summarizeRun({
      candidates: 12,
      enqueued: 4,
      droppedIcp: 6,
      droppedLowSignal: 0,
      costUsd: 0.42,
    });
    expect(out).not.toContain("low=");
  });
});

describe("summarizeRun · perCohort breakdown (accelerator-batch sweep)", () => {
  it("renders hits sorted by record count desc, with zeros collapsed", () => {
    const out = summarizeRun({
      candidates: 53,
      enqueued: 25,
      droppedIcp: 28,
      costUsd: 4.21,
      perCohort: [
        { cohort: "yc-w26", records: 28 },
        { cohort: "spc-2026-1", records: 0, error: "no hits" },
        { cohort: "yc-f25", records: 25 },
        { cohort: "neo-class-2026", records: 0, error: "no hits" },
        { cohort: "techstars-spring-2026", records: 0, error: "no hits" },
      ],
    });
    expect(out).toContain("yc-w26: 28");
    expect(out).toContain("yc-f25: 25");
    // Hits come before the empty summary.
    expect(out.indexOf("yc-w26: 28")).toBeLessThan(out.indexOf("+3 empty"));
    // Zeros collapse into a trailing tag list (up to 3 tag names).
    expect(out).toMatch(/\+3 empty \(spc-2026-1, neo-class-2026, techstars-spring-2026\)/);
  });

  it("adds '…' overflow when more than 3 cohorts came back empty", () => {
    const out = summarizeRun({
      perCohort: [
        { cohort: "yc-w26", records: 10 },
        { cohort: "a", records: 0, error: "no hits" },
        { cohort: "b", records: 0, error: "no hits" },
        { cohort: "c", records: 0, error: "no hits" },
        { cohort: "d", records: 0, error: "no hits" },
      ],
    });
    expect(out).toMatch(/\+4 empty \(a, b, c, …\)/);
  });

  it("omits the empty-summary segment when every cohort had hits", () => {
    const out = summarizeRun({
      perCohort: [
        { cohort: "yc-w26", records: 10 },
        { cohort: "yc-f25", records: 8 },
      ],
    });
    expect(out).toContain("yc-w26: 10");
    expect(out).toContain("yc-f25: 8");
    expect(out).not.toContain("empty");
  });

  it("ignores malformed perCohort entries", () => {
    const out = summarizeRun({
      candidates: 10,
      perCohort: [
        null,
        "string",
        { records: 5 }, // missing cohort
        { cohort: "yc-w26", records: 5 },
      ],
    });
    expect(out).toContain("yc-w26: 5");
  });

  it("truncates long breakdowns with an ellipsis", () => {
    const perCohort = Array.from({ length: 30 }, (_, i) => ({
      cohort: `cohort-${i}-with-a-long-name`,
      records: 30 - i,
    }));
    const out = summarizeRun({ perCohort });
    // The breakdown segment alone is capped at 200 chars; full line stays
    // under SchedulerStrip's comfort zone.
    expect(out.length).toBeLessThan(260);
    expect(out).toMatch(/…$/);
  });
});
