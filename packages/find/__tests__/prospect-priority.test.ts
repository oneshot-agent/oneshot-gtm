import { describe, expect, it } from "vitest";
import { scoreProspectPriority } from "../src/prospect-priority.ts";

describe("scoreProspectPriority", () => {
  it("uses the documented weights and keeps missing evidence neutral", () => {
    const score = scoreProspectPriority({
      payload: {},
      finder: "unknown",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(score.total).toBe(50);
    expect(score.components).toEqual({
      personFit: 50,
      accountFit: 50,
      intentStrength: 50,
      timingFreshness: 50,
      signalConfidence: 50,
      contactability: 50,
    });
    expect(score.version).toBe("heuristic-v1");
  });

  it("reuses stored finder evidence without calling external services", () => {
    const score = scoreProspectPriority({
      finder: "github-stars",
      foundAt: "2026-08-31T12:00:00Z",
      now: new Date("2026-09-01T12:00:00Z"),
      payload: {
        title: "Founder & CEO",
        company: "Acme",
        email: "founder@acme.test",
        repoUrl: "https://github.com/acme/repo",
        summary: "AI tooling",
      },
    });
    expect(score.total).toBeGreaterThan(75);
    expect(score.reasons).toContain("Starred a relevant repository");
    expect(score.reasons.length).toBeLessThanOrEqual(5);
  });

  it("clamps components and rounds only the final total", () => {
    const score = scoreProspectPriority({ payload: { points: 1e30 }, finder: "show-hn" });
    expect(Object.values(score.components).every((value) => value >= 0 && value <= 100)).toBe(true);
    expect(Number.isInteger(score.total)).toBe(true);
  });
});
