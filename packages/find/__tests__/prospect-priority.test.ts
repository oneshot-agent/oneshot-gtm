import { describe, expect, it, vi } from "vitest";
const ledgerMock = vi.hoisted(() => ({
  listQueueForPriority: vi.fn(),
  setQueuePriority: vi.fn(),
}));
vi.mock("@oneshot-gtm/core", () => ({ getLedger: () => ledgerMock }));
import { scoreProspectPriority, scoreStoredProspects } from "../src/prospect-priority.ts";

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

  it("recognizes finder names embedded in persisted source values", () => {
    const showHn = scoreProspectPriority({ payload: {}, finder: "find:show-hn" });
    const githubStars = scoreProspectPriority({
      payload: {},
      finder: "find:github-stars:acme/widgets",
    });

    expect(showHn.components.intentStrength).toBe(78);
    expect(githubStars.components.intentStrength).toBe(82);
  });

  it("handles negative source engagement without producing NaN", () => {
    const score = scoreProspectPriority({ payload: { points: -2 }, finder: "unknown" });
    expect(score.components.intentStrength).toBe(55);
    expect(Number.isFinite(score.total)).toBe(true);
  });

  it("does not persist malformed rows during a dry run", () => {
    ledgerMock.listQueueForPriority.mockReturnValueOnce([
      {
        id: 1,
        payload_json: "{malformed",
        play_name: "show-hn",
        source: "find:show-hn",
      },
    ]);
    ledgerMock.setQueuePriority.mockClear();

    const result = scoreStoredProspects({ scope: "all", limit: 10, dryRun: true });

    expect(result.skippedMalformed).toBe(1);
    expect(ledgerMock.setQueuePriority).not.toHaveBeenCalled();
  });

  it("clamps components and rounds only the final total", () => {
    const score = scoreProspectPriority({ payload: { points: 1e30 }, finder: "show-hn" });
    expect(Object.values(score.components).every((value) => value >= 0 && value <= 100)).toBe(true);
    expect(Number.isInteger(score.total)).toBe(true);
  });
});
