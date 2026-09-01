import { describe, expect, it } from "vitest";
import {
  NEUTRAL,
  PRIORITY_WEIGHTS,
  clamp100,
  computePriority,
  type PriorityEvidence,
} from "../src/_priority.ts";

const NOW = new Date("2026-09-01T12:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("priority engine — contract", () => {
  it("weights sum to exactly 100", () => {
    const sum = Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("empty evidence is neutral everywhere, not zero", () => {
    const p = computePriority("show-hn", {}, NOW);
    expect(p.version).toBe("heuristic-v1");
    expect(p.finder).toBe("show-hn");
    expect(p.scoredAt).toBe(NOW.toISOString());
    expect(p.total).toBe(NEUTRAL);
    for (const v of Object.values(p.components)) expect(v).toBe(NEUTRAL);
    expect(p.reasons).toEqual([]);
  });

  it("clamps components and total to integers 0..100", () => {
    const p = computePriority(
      "x",
      {
        intentSignals: [{ kind: "k", strength: 250, reason: "over" }],
        accountSignals: [{ kind: "k", strength: -40, reason: "under" }],
      },
      NOW,
    );
    expect(p.components.intentStrength).toBe(100);
    // Negative strength loses to the neutral base, and nothing goes below 0.
    expect(p.components.accountFit).toBe(NEUTRAL);
    expect(p.total).toBeGreaterThanOrEqual(0);
    expect(p.total).toBeLessThanOrEqual(100);
    expect(Number.isInteger(p.total)).toBe(true);
    for (const v of Object.values(p.components)) expect(Number.isInteger(v)).toBe(true);
  });

  it("identical evidence produces an identical artifact, reasons included", () => {
    const ev: PriorityEvidence = {
      title: "CTO",
      companyKnown: true,
      accountSignals: [{ kind: "funding", strength: 85, reason: "raised Seed $2.0M" }],
      intentSignals: [{ kind: "fresh-budget", strength: 70, reason: "fresh Seed budget" }],
      eventAt: daysAgo(2),
      evidenceUrlCount: 1,
      hasEmail: true,
      hasLinkedin: true,
    };
    const a = computePriority("post-funding", ev, NOW);
    const b = computePriority("post-funding", ev, NOW);
    expect(b).toEqual(a);
  });

  it("computes the weighted total exactly", () => {
    const p = computePriority(
      "t",
      {
        title: "CTO", // personFit 90
        companyKnown: true, // accountFit 55
        intentSignals: [{ kind: "k", strength: 80, reason: "r" }], // intent 80
        eventAt: daysAgo(2), // freshness 90
        evidenceUrlCount: 1, // confidence 65
        hasEmail: true,
        hasLinkedin: true, // contactability 85
      },
      NOW,
    );
    expect(p.components).toEqual({
      personFit: 90,
      accountFit: 55,
      intentStrength: 80,
      timingFreshness: 90,
      signalConfidence: 65,
      contactability: 85,
    });
    // 90*.30 + 55*.20 + 80*.20 + 90*.15 + 65*.10 + 85*.05 = 78.25 → 78
    expect(p.total).toBe(78);
  });
});

describe("priority engine — components", () => {
  it("bands seniority: exec > vp > senior > unknown title", () => {
    const at = (title: string) => computePriority("t", { title }, NOW).components.personFit;
    expect(at("Co-founder & CEO")).toBe(90);
    expect(at("VP Engineering")).toBe(75);
    expect(at("Head of Growth")).toBe(75);
    expect(at("Senior Engineer")).toBe(60);
    expect(at("Analyst")).toBe(NEUTRAL);
  });

  it("prefers the seniorityHint over the title", () => {
    const p = computePriority("t", { title: "Analyst", seniorityHint: "Founder @ Acme" }, NOW);
    expect(p.components.personFit).toBe(90);
    expect(p.reasons[0]).toBe("title: Founder @ Acme");
  });

  it("falls through to a band-matching title when the hint matches no band", () => {
    const p = computePriority("t", { title: "CTO", seniorityHint: "AI enthusiast" }, NOW);
    expect(p.components.personFit).toBe(90);
    expect(p.reasons[0]).toBe("title: CTO");
  });

  it("bands freshness by age and treats the future as maximally timely", () => {
    const at = (ev: PriorityEvidence) => computePriority("t", ev, NOW).components.timingFreshness;
    expect(at({ eventAt: daysAgo(1) })).toBe(90);
    expect(at({ eventAt: daysAgo(5) })).toBe(80);
    expect(at({ eventAt: daysAgo(20) })).toBe(60);
    expect(at({ eventAt: daysAgo(60) })).toBe(40);
    expect(at({ eventAt: daysAgo(200) })).toBe(25);
    expect(at({ eventAt: daysAgo(-3) })).toBe(90); // upcoming
    expect(at({})).toBe(NEUTRAL);
    // Direct ageDays wins over eventAt.
    expect(at({ ageDays: 200, eventAt: daysAgo(1) })).toBe(25);
    // Unparseable timestamps read as unknown, never throw.
    expect(at({ eventAt: "not-a-date" })).toBe(NEUTRAL);
  });

  it("scores confidence from evidence links and quoted text, capped at two links", () => {
    const at = (ev: PriorityEvidence) => computePriority("t", ev, NOW).components.signalConfidence;
    expect(at({})).toBe(NEUTRAL);
    expect(at({ evidenceUrlCount: 1 })).toBe(65);
    expect(at({ evidenceUrlCount: 5, hasEvidenceText: true })).toBe(100);
  });

  it("scores contactability from channels, neutral when nothing is known", () => {
    const at = (ev: PriorityEvidence) => computePriority("t", ev, NOW).components.contactability;
    expect(at({})).toBe(NEUTRAL);
    expect(at({ hasEmail: true, hasLinkedin: true })).toBe(85);
    expect(at({ hasEmail: false, dmOpen: true })).toBe(45);
  });

  it("caps reasons at 4, ordered by component weight", () => {
    const p = computePriority(
      "t",
      {
        title: "CEO",
        accountSignals: [{ kind: "a", strength: 80, reason: "account reason" }],
        intentSignals: [{ kind: "i", strength: 80, reason: "intent reason" }],
        eventAt: daysAgo(1),
        evidenceUrlCount: 2,
        hasEvidenceText: true,
      },
      NOW,
    );
    expect(p.reasons).toHaveLength(4);
    expect(p.reasons).toEqual(["title: CEO", "account reason", "intent reason", "signal 1d old"]);
  });

  it("takes the strongest of several signals and keeps all their reasons", () => {
    const p = computePriority(
      "t",
      {
        intentSignals: [
          { kind: "weak", strength: 55, reason: "weak" },
          { kind: "strong", strength: 80, reason: "strong" },
        ],
      },
      NOW,
    );
    expect(p.components.intentStrength).toBe(80);
    expect(p.reasons).toEqual(["strong", "weak"]);
  });
});

describe("clamp100", () => {
  it("rounds then clamps", () => {
    expect(clamp100(78.5)).toBe(79);
    expect(clamp100(-3)).toBe(0);
    expect(clamp100(140)).toBe(100);
  });
});
