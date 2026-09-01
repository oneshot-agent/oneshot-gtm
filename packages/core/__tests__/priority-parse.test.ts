import { describe, expect, it } from "vitest";
import { parseProspectPriority } from "../src/priority.ts";
import type { ProspectPriority } from "../src/types.ts";

const VALID: ProspectPriority = {
  version: "heuristic-v1",
  total: 72,
  components: {
    personFit: 90,
    accountFit: 55,
    intentStrength: 80,
    timingFreshness: 60,
    signalConfidence: 65,
    contactability: 85,
  },
  reasons: ["title: CTO"],
  finder: "post-funding",
  scoredAt: "2026-09-01T12:00:00.000Z",
};

describe("parseProspectPriority — the single validity authority", () => {
  it("round-trips a valid artifact", () => {
    expect(parseProspectPriority(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("rejects null, broken JSON, non-objects, and foreign versions", () => {
    expect(parseProspectPriority(null)).toBeNull();
    expect(parseProspectPriority(undefined)).toBeNull();
    expect(parseProspectPriority("")).toBeNull();
    expect(parseProspectPriority("{broken")).toBeNull();
    expect(parseProspectPriority("[1,2]")).toBeNull();
    expect(parseProspectPriority(JSON.stringify({ ...VALID, version: "heuristic-v2" }))).toBeNull();
  });

  it("rejects partial artifacts — a bare version stamp is not a score", () => {
    expect(parseProspectPriority(JSON.stringify({ version: "heuristic-v1" }))).toBeNull();
    expect(
      parseProspectPriority(JSON.stringify({ version: "heuristic-v1", total: 50 })),
    ).toBeNull();
  });

  it("rejects out-of-range, fractional, and non-numeric scores", () => {
    expect(parseProspectPriority(JSON.stringify({ ...VALID, total: -1 }))).toBeNull();
    expect(parseProspectPriority(JSON.stringify({ ...VALID, total: 101 }))).toBeNull();
    expect(parseProspectPriority(JSON.stringify({ ...VALID, total: 72.5 }))).toBeNull();
    expect(
      parseProspectPriority(
        JSON.stringify({ ...VALID, components: { ...VALID.components, personFit: 999 } }),
      ),
    ).toBeNull();
    expect(
      parseProspectPriority(
        JSON.stringify({ ...VALID, components: { ...VALID.components, contactability: "85" } }),
      ),
    ).toBeNull();
  });

  it("normalizes the trimmings: non-string reasons dropped, missing scoredAt reads as empty", () => {
    const parsed = parseProspectPriority(
      JSON.stringify({ ...VALID, reasons: ["ok", 42, null], scoredAt: undefined }),
    )!;
    expect(parsed.reasons).toEqual(["ok"]);
    expect(parsed.scoredAt).toBe("");
  });
});
