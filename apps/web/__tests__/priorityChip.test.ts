import { describe, expect, it } from "vitest";
import type { ProspectPriorityView } from "@oneshot-gtm/shared-types";
import { priorityBreakdown, priorityChip } from "../src/lib/priorityChip.ts";

function priority(total: number, reasons: string[] = ["title: CTO"]): ProspectPriorityView {
  return {
    version: "heuristic-v1",
    total,
    components: {
      personFit: 90,
      accountFit: 55,
      intentStrength: 80,
      timingFreshness: 60,
      signalConfidence: 65,
      contactability: 85,
    },
    reasons,
    finder: "post-funding",
    scoredAt: "2026-09-01T12:00:00.000Z",
  };
}

describe("priorityChip", () => {
  it("returns null for rows without a score", () => {
    expect(priorityChip(null)).toBeNull();
  });

  it("labels the score as shadow", () => {
    expect(priorityChip(priority(72))!.label).toBe("72 · shadow");
  });

  it("buckets tone at the 40 and 70 boundaries, never using a blocking tone", () => {
    expect(priorityChip(priority(70))!.tone).toBe("signal");
    expect(priorityChip(priority(69))!.tone).toBe("neutral");
    expect(priorityChip(priority(40))!.tone).toBe("neutral");
    expect(priorityChip(priority(39))!.tone).toBe("receipt");
    expect(priorityChip(priority(0))!.tone).toBe("receipt");
  });

  it("joins the top reasons into the hover title, capped at four", () => {
    const chip = priorityChip(priority(72, ["a", "b", "c", "d", "e"]))!;
    expect(chip.title).toBe("a · b · c · d");
  });

  it("falls back to naming the finder when the artifact has no usable reasons", () => {
    expect(priorityChip(priority(72, ["", "  "]))!.title).toBe(
      "experimental priority score (post-funding)",
    );
  });

  it("suppresses reason text under privacy mode (reasons can embed names/companies)", () => {
    const chip = priorityChip(priority(72, ["just started as CTO at Acme"]), true)!;
    expect(chip.title).toBe("experimental priority score (post-funding)");
    expect(chip.label).toBe("72 · shadow");
  });
});

describe("priorityBreakdown", () => {
  it("lists components in weight order with their v1 weights", () => {
    const rows = priorityBreakdown(priority(72));
    expect(rows).toEqual([
      { component: "person fit", score: 90, weightPct: 30 },
      { component: "account fit", score: 55, weightPct: 20 },
      { component: "intent", score: 80, weightPct: 20 },
      { component: "freshness", score: 60, weightPct: 15 },
      { component: "confidence", score: 65, weightPct: 10 },
      { component: "contactability", score: 85, weightPct: 5 },
    ]);
  });
});

describe("per-version rendering", () => {
  it("a v2 artifact renders with v2's weight table", () => {
    const v2 = { ...priority(61), version: "heuristic-v2" as const };
    const rows = priorityBreakdown(v2);
    expect(rows[0]).toEqual({ component: "person fit", score: 90, weightPct: 30 });
    expect(rows.reduce((a, r) => a + r.weightPct, 0)).toBe(100);
    expect(priorityChip(v2)!.label).toBe("61 · shadow");
  });
});

describe("shadow suffix under ranked order", () => {
  it("drops the suffix once the score drives ordering", () => {
    expect(priorityChip(priority(72), false, { shadow: false })!.label).toBe("72");
    expect(priorityChip(priority(72), false, { shadow: true })!.label).toBe("72 · shadow");
  });
});
