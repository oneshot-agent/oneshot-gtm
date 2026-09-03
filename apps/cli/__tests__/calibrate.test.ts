import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ledger } from "@oneshot-gtm/core";

let ledger: Ledger;
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger };
});

const { Ledger: RealLedger, parseProspectCalibration } = await import("@oneshot-gtm/core");
const { PRIORITY_COMPONENT_KEYS } = await import("@oneshot-gtm/shared-types");
const { CALIBRATION_THRESHOLDS, assessReadiness, commandCalibrate, fitFinder } =
  await import("../src/commands/calibrate.ts");

let dir: string;
let dbPath: string;
let calPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-calibrate-"));
  dbPath = join(dir, "ledger.sqlite");
  calPath = join(dir, "priority-calibration.json");
  process.env["ONESHOT_GTM_CALIBRATION"] = calPath;
  ledger = new RealLedger(dbPath);
});

afterEach(() => {
  ledger.close();
  delete process.env["ONESHOT_GTM_CALIBRATION"];
  rmSync(dir, { recursive: true, force: true });
});

const rawDb = () =>
  (ledger as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } })
    .db;

function artifact(total: number): string {
  return JSON.stringify({
    version: "heuristic-v2",
    total,
    components: {
      personFit: total,
      accountFit: 50,
      intentStrength: total,
      timingFreshness: 50,
      signalConfidence: 50,
      contactability: 50,
    },
    reasons: [],
    finder: "t",
    scoredAt: "2026-08-01T10:00:00.000Z",
  });
}

/** A mature sent row (old sent_at) with a score; optionally a human reply. */
function seedSent(i: number, opts: { replied: boolean; total: number }): void {
  const prospectId = ledger.upsertProspect({ email: `p${i}@a.dev` });
  const id = ledger.enqueueTarget({
    playName: "luma-events",
    payload: { name: "x", email: `p${i}@a.dev` },
    dedupeKey: `k-${i}`,
    source: "test",
  })!;
  ledger.setQueueProspectId(id, prospectId);
  ledger.setQueuePriority(id, JSON.parse(artifact(opts.total)));
  ledger.setQueueStatus({ id, status: "sent" });
  rawDb().prepare(`UPDATE target_queue SET sent_at = '2026-01-01T10:00:00Z' WHERE id = ?`).run(id);
  if (opts.replied) {
    rawDb()
      .prepare(
        `INSERT INTO inbox_replies(id, thread_key, prospect_id, from_email, body, received_at, kind)
         VALUES(?, 't', ?, 'x@y.z', 'hi', '2026-01-03T10:00:00Z', 'human')`,
      )
      .run(`r-${i}`, prospectId);
  }
}

describe("readiness gate", () => {
  it("under-threshold → 'not yet' and no artifact written, even with --fit", () => {
    for (let i = 0; i < 10; i++) seedSent(i, { replied: i < 2, total: 60 });
    commandCalibrate({ fit: true });
    expect(existsSync(calPath)).toBe(false);
  });

  it("assessReadiness applies all three floors", () => {
    const mk = (positives: number, negatives: number) =>
      assessReadiness(
        Array.from({ length: positives + negatives }, (_, i) => ({
          id: i,
          finder: "f",
          dedupeKey: `k${i}`,
          priorityTotal: 50,
          components: null,
          joinable: true,
          daysSinceSend: 30,
          outcome: i < positives ? ("reply" as const) : ("none" as const),
          label: i < positives ? ("positive" as const) : ("negative" as const),
        })),
      )[0]!;
    expect(mk(29, 200).ready).toBe(false); // positives floor
    expect(mk(40, 49).ready).toBe(false); // negatives floor
    expect(mk(31, 60).ready).toBe(false); // mature floor (91 < 150)
    expect(mk(60, 100).ready).toBe(true);
    expect(CALIBRATION_THRESHOLDS.minMature).toBe(150);
  });
});

describe("--fit on a ready finder", () => {
  function seedReady(): void {
    // 60 replied high-scorers, 120 silent low-scorers — separable by design.
    for (let i = 0; i < 60; i++) seedSent(i, { replied: true, total: 80 });
    for (let i = 60; i < 180; i++) seedSent(i, { replied: false, total: 40 });
  }

  it("writes a validator-clean artifact with keyed weights and a real holdout AUC", () => {
    seedReady();
    commandCalibrate({ fit: true });
    expect(existsSync(calPath)).toBe(true);
    const parsed = parseProspectCalibration(readFileSync(calPath, "utf8"))!;
    expect(parsed).not.toBeNull();
    const fit = parsed.perFinder["luma-events"]!;
    expect(Object.keys(fit.weights).toSorted()).toEqual([...PRIORITY_COMPONENT_KEYS].toSorted());
    expect(fit.nPos).toBe(60);
    expect(fit.nNeg).toBe(120);
    expect(fit.holdoutAuc).toBeGreaterThan(0.9); // separable seed
    // Informative components got the weight; constant ones stayed near zero.
    expect(Math.abs(fit.weights.personFit)).toBeGreaterThan(Math.abs(fit.weights.accountFit));
  });

  it("refits are deterministic and per-finder merge preserves other entries", () => {
    seedReady();
    commandCalibrate({ fit: true });
    const first = readFileSync(calPath, "utf8");
    // Inject a second finder's entry, refit — luma is replaced, other kept.
    const doctored = parseProspectCalibration(first)!;
    doctored.perFinder["show-hn"] = doctored.perFinder["luma-events"]!;
    rmSync(calPath);
    writeFileSync(calPath, JSON.stringify(doctored));
    commandCalibrate({ fit: true });
    const merged = parseProspectCalibration(readFileSync(calPath, "utf8"))!;
    expect(merged.perFinder["show-hn"]).toBeDefined();
    expect(merged.perFinder["luma-events"]!.weights).toEqual(
      parseProspectCalibration(first)!.perFinder["luma-events"]!.weights,
    );
  });
});

describe("fitFinder edge cases", () => {
  it("returns null with no usable rows", () => {
    expect(fitFinder([])).toBeNull();
  });
});
