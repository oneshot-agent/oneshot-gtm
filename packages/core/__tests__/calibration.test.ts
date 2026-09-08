import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  calibrationPath,
  parseProspectCalibration,
  readProspectCalibration,
  type ProspectCalibration,
} from "../src/calibration.ts";

const VALID: ProspectCalibration = {
  version: "logistic-v1",
  fittedAt: "2026-09-02T12:00:00.000Z",
  outcome: "reply",
  maturityDays: 14,
  perFinder: {
    "luma-events": {
      weights: {
        personFit: 0.4,
        accountFit: -0.1,
        intentStrength: 0.9,
        timingFreshness: 0.2,
        signalConfidence: 0.1,
        contactability: 0.0,
      },
      bias: -2.1,
      nPos: 31,
      nNeg: 60,
      holdoutAuc: 0.66,
    },
  },
};

afterEach(() => {
  delete process.env["ONESHOT_GTM_CALIBRATION"];
});

describe("parseProspectCalibration", () => {
  it("round-trips a valid artifact", () => {
    expect(parseProspectCalibration(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("rejects broken JSON, wrong version/outcome, and non-finite weights", () => {
    expect(parseProspectCalibration("{broken")).toBeNull();
    expect(
      parseProspectCalibration(JSON.stringify({ ...VALID, version: "logistic-v2" })),
    ).toBeNull();
    expect(parseProspectCalibration(JSON.stringify({ ...VALID, outcome: "approval" }))).toBeNull();
    const badWeights = structuredClone(VALID) as unknown as Record<string, never>;
    (badWeights as unknown as ProspectCalibration).perFinder["luma-events"]!.weights.personFit =
      Number.NaN;
    expect(parseProspectCalibration(JSON.stringify(badWeights))).toBeNull();
  });

  it("normalizes the trimmings: missing holdoutAuc reads null, missing fittedAt empty", () => {
    const clone = structuredClone(VALID) as unknown as {
      fittedAt?: string;
      perFinder: Record<string, { holdoutAuc?: number | null }>;
    };
    delete clone.fittedAt;
    delete clone.perFinder["luma-events"]!.holdoutAuc;
    const parsed = parseProspectCalibration(JSON.stringify(clone))!;
    expect(parsed.fittedAt).toBe("");
    expect(parsed.perFinder["luma-events"]!.holdoutAuc).toBeNull();
  });
});

describe("readProspectCalibration", () => {
  it("absent file → null; env override respected; unusable file throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "oneshot-calibration-"));
    try {
      const path = join(dir, "cal.json");
      process.env["ONESHOT_GTM_CALIBRATION"] = path;
      expect(calibrationPath()).toBe(path);
      expect(readProspectCalibration()).toBeNull();

      writeFileSync(path, JSON.stringify(VALID));
      expect(readProspectCalibration()).toEqual(VALID);

      writeFileSync(path, "{corrupt");
      expect(() => readProspectCalibration()).toThrow(/unusable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
