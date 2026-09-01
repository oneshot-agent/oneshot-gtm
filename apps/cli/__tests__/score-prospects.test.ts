import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ledger } from "@oneshot-gtm/core";

// The command reads the singleton; hand it a fresh real ledger per test so the
// backfill semantics (resume-skip, refresh, dry-run) are exercised end-to-end
// against real SQL — with zero network by construction (no SDK import at all).
let ledger: Ledger;
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger };
});

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const {
  anchorFor,
  bucketOf,
  buildShadowReport,
  commandScoreProspects,
  hasCurrentScore,
  isAutoRejected,
  parseScope,
  resolveCap,
  shouldSkipRow,
} = await import("../src/commands/score-prospects.ts");

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-score-prospects-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new RealLedger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

function enqueue(
  playName: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): number {
  return ledger.enqueueTarget({
    playName,
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: `find:${playName}`,
    ...extra,
  })!;
}

const FUNDING_PAYLOAD = {
  name: "Ada",
  email: "ada@acme.dev",
  company: "Acme",
  round: "Seed",
  amountUsd: 2_000_000,
  sourceUrl: "https://example.com",
  title: "CEO",
};

describe("pure helpers", () => {
  it("parseScope: all by default, known plays pass, typos are rejected", () => {
    expect(parseScope(undefined)).toBe("all");
    expect(parseScope("post-funding")).toBe("post-funding");
    expect(() => parseScope("post-fundig")).toThrow(/unknown --scope/);
  });

  it("resolveCap never widens a run", () => {
    expect(resolveCap(undefined)).toBeUndefined();
    expect(resolveCap(Number.NaN)).toBe(0);
    expect(resolveCap(5.9)).toBe(5);
    expect(resolveCap(-2)).toBe(0);
  });

  it("bucketOf boundaries", () => {
    expect(bucketOf(0)).toBe("0-19");
    expect(bucketOf(19)).toBe("0-19");
    expect(bucketOf(20)).toBe("20-39");
    expect(bucketOf(59)).toBe("40-59");
    expect(bucketOf(79)).toBe("60-79");
    expect(bucketOf(100)).toBe("80-100");
  });

  it("anchorFor normalizes SQLite's zone-less UTC found_at", () => {
    expect(anchorFor({ found_at: "2026-09-01 10:00:00" }).toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    expect(anchorFor({ found_at: "2026-09-01T10:00:00.000Z" }).toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    // Garbage falls back to a valid clock rather than NaN-poisoning the score.
    expect(Number.isFinite(anchorFor({ found_at: "garbage" }).getTime())).toBe(true);
  });

  it("hasCurrentScore / shouldSkipRow require the FULL valid artifact, not just the version", () => {
    expect(hasCurrentScore({ priority_json: null })).toBe(false);
    expect(hasCurrentScore({ priority_json: "{broken" })).toBe(false);
    expect(hasCurrentScore({ priority_json: JSON.stringify({ version: "heuristic-v0" }) })).toBe(
      false,
    );
    // A partial/corrupt artifact reads as unscored — the API hides it as
    // priority:null, so treating it as current would make it unrepairable.
    expect(hasCurrentScore({ priority_json: JSON.stringify({ version: "heuristic-v1" }) })).toBe(
      false,
    );
    expect(
      hasCurrentScore({ priority_json: JSON.stringify({ version: "heuristic-v1", total: 50 }) }),
    ).toBe(false);
    const current = JSON.stringify({
      version: "heuristic-v1",
      total: 50,
      components: {
        personFit: 50,
        accountFit: 50,
        intentStrength: 50,
        timingFreshness: 50,
        signalConfidence: 50,
        contactability: 50,
      },
      reasons: [],
      finder: "post-funding",
      scoredAt: "2026-09-01T12:00:00.000Z",
    });
    expect(hasCurrentScore({ priority_json: current })).toBe(true);
    expect(shouldSkipRow({ priority_json: current }, false)).toBe(true);
    expect(shouldSkipRow({ priority_json: current }, true)).toBe(false);
  });

  it("a partial artifact is repaired by a plain backfill run, no --refresh needed", () => {
    const id = enqueue("post-funding", FUNDING_PAYLOAD);
    const db = (
      ledger as unknown as {
        db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } };
      }
    ).db;
    db.prepare(`UPDATE target_queue SET priority_json = ? WHERE id = ?`).run(
      JSON.stringify({ version: "heuristic-v1" }),
      id,
    );
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    const repaired = JSON.parse(ledger.getQueueRow(id)!.priority_json!);
    expect(repaired.finder).toBe("post-funding");
    expect(typeof repaired.total).toBe("number");
  });

  it("isAutoRejected matches only the auto: rejection prefix", () => {
    expect(isAutoRejected({ status: "rejected", notes: "auto: ICP — no" })).toBe(true);
    expect(isAutoRejected({ status: "rejected", notes: "not a fit for us" })).toBe(false);
    expect(isAutoRejected({ status: "approved", notes: "auto: ICP — no" })).toBe(false);
    expect(isAutoRejected({ status: "rejected", notes: null })).toBe(false);
  });
});

describe("commandScoreProspects", () => {
  it("dry-run writes nothing", () => {
    const id = enqueue("post-funding", FUNDING_PAYLOAD);
    commandScoreProspects({ refresh: false, dryRun: true, report: false });
    expect(ledger.getQueueRow(id)!.priority_json).toBeNull();
  });

  it("scores pending/approved rows from stored payloads and resumes past them", () => {
    const id = enqueue("post-funding", FUNDING_PAYLOAD);
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    const written = JSON.parse(ledger.getQueueRow(id)!.priority_json!);
    expect(written.version).toBe("heuristic-v1");
    expect(written.finder).toBe("post-funding");
    // Deterministic: anchored to found_at, so a re-run reproduces it exactly…
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    expect(JSON.parse(ledger.getQueueRow(id)!.priority_json!)).toEqual(written);
    // …and resume-skip means a doctored current-version artifact survives
    // without --refresh but is recomputed with it.
    const doctored = { ...written, total: 1 };
    ledger.setQueuePriority(id, doctored);
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    expect(JSON.parse(ledger.getQueueRow(id)!.priority_json!)).toEqual(doctored);
    commandScoreProspects({ refresh: true, dryRun: false, report: false });
    expect(JSON.parse(ledger.getQueueRow(id)!.priority_json!)).toEqual(written);
  });

  it("honors --scope and --limit", () => {
    const funding = enqueue("post-funding", FUNDING_PAYLOAD);
    const other = enqueue("show-hn", { founderEmail: "s@x.dev", postTitle: "Show HN: X" });
    commandScoreProspects({ scope: "post-funding", refresh: false, dryRun: false, report: false });
    expect(ledger.getQueueRow(funding)!.priority_json).not.toBeNull();
    expect(ledger.getQueueRow(other)!.priority_json).toBeNull();

    const a = enqueue("post-funding", FUNDING_PAYLOAD);
    const b = enqueue("post-funding", FUNDING_PAYLOAD);
    commandScoreProspects({
      scope: "post-funding",
      limit: 1,
      refresh: false,
      dryRun: false,
      report: false,
    });
    // id-ascending: the earlier unscored row wins the single slot.
    expect(ledger.getQueueRow(a)!.priority_json).not.toBeNull();
    expect(ledger.getQueueRow(b)!.priority_json).toBeNull();
  });

  it("leaves rows without an adapter and malformed payloads unscored, without throwing", () => {
    const manual = enqueue("profile-intro", { name: "x" });
    const malformed = enqueue("post-funding", FUNDING_PAYLOAD);
    const db = (
      ledger as unknown as {
        db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } };
      }
    ).db;
    db.prepare(`UPDATE target_queue SET payload_json = '{broken' WHERE id = ?`).run(malformed);
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    expect(ledger.getQueueRow(manual)!.priority_json).toBeNull();
    expect(ledger.getQueueRow(malformed)!.priority_json).toBeNull();
  });
});

describe("--report", () => {
  it("respects --scope instead of reporting the whole queue", () => {
    enqueue("post-funding", FUNDING_PAYLOAD);
    enqueue("show-hn", { founderEmail: "s@x.dev", postTitle: "Show HN: X" });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      commandScoreProspects({ scope: "post-funding", refresh: false, dryRun: true, report: true });
    } finally {
      spy.mockRestore();
    }
    const output = writes.join("");
    const reportSection = output.slice(output.indexOf("shadow report"));
    expect(reportSection).toContain("post-funding");
    expect(reportSection).not.toContain("show-hn");
  });
});

describe("--all-statuses methodology evaluation", () => {
  it("scores historical rows and gauges score vs human call, auto-rejections excluded", () => {
    // Human-approved-and-sent strong candidate vs human-rejected weak one.
    const sent = enqueue("post-funding", FUNDING_PAYLOAD);
    ledger.setQueueStatus({ id: sent, status: "sent" });
    const weak = enqueue("post-funding", { name: "Bo", email: "bo@x.dev" });
    ledger.setQueueStatus({ id: weak, status: "rejected", notes: "not a fit" });
    const auto = enqueue(
      "post-funding",
      { name: "Zed", email: "z@x.dev" },
      { initialStatus: "rejected", notes: "auto: ICP — no" },
    );

    // Default scope skips all three (none is pending/approved)…
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    expect(ledger.getQueueRow(sent)!.priority_json).toBeNull();
    // …and --all-statuses scores them.
    commandScoreProspects({ refresh: false, dryRun: false, report: false, allStatuses: true });
    expect(ledger.getQueueRow(sent)!.priority_json).not.toBeNull();
    expect(ledger.getQueueRow(weak)!.priority_json).not.toBeNull();
    expect(ledger.getQueueRow(auto)!.priority_json).not.toBeNull();

    const report = buildShadowReport(ledger.listQueue({ limit: 1000 }));
    const funding = report.find((r) => r.finder === "post-funding")!;
    // Gauge covers only human calls: 1 approved-and-sent, 1 human-rejected.
    expect(funding.approvedScored.n).toBe(1);
    expect(funding.rejectedScored.n).toBe(1);
    expect(funding.approvedScored.mean).toBeGreaterThan(funding.rejectedScored.mean!);
    // The scored auto-rejection influences neither side.
    expect(funding.humanReviewed).toBe(2);
    // Buckets still describe the live queue only — nothing pending/approved here.
    expect(funding.scored).toBe(0);
  });
});

describe("buildShadowReport — human-vs-auto provenance", () => {
  it("excludes auto: rejections from human labels and rates", () => {
    const approved = enqueue("post-funding", FUNDING_PAYLOAD);
    ledger.setQueueStatus({ id: approved, status: "approved" });
    const humanRejected = enqueue("post-funding", FUNDING_PAYLOAD, {
      notes: "wrong segment",
    });
    ledger.setQueueStatus({ id: humanRejected, status: "rejected", notes: "wrong segment" });
    enqueue("post-funding", { name: "x" }, { initialStatus: "rejected", notes: "auto: ICP — no" });
    commandScoreProspects({ refresh: false, dryRun: false, report: false });

    const report = buildShadowReport(ledger.listQueue({ limit: 1000 }));
    const funding = report.find((r) => r.finder === "post-funding")!;
    expect(funding.rows).toBe(3);
    // Only pending/approved rows get backfilled; the human rejection keeps null.
    expect(funding.scored).toBe(1);
    // Auto-rejection is excluded: 2 human labels, 1 approved.
    expect(funding.humanReviewed).toBe(2);
    expect(funding.humanApprovalRate).toBeCloseTo(0.5);
  });

  it("reports null approval rate when no human labels exist", () => {
    enqueue("post-funding", FUNDING_PAYLOAD);
    const report = buildShadowReport(ledger.listQueue({ limit: 1000 }));
    expect(report[0]!.humanApprovalRate).toBeNull();
  });

  it("excludes dispatched rows from the score buckets — they only describe the live queue", () => {
    const sent = enqueue("post-funding", FUNDING_PAYLOAD);
    commandScoreProspects({ refresh: false, dryRun: false, report: false });
    ledger.setQueueStatus({ id: sent, status: "sent" });
    const report = buildShadowReport(ledger.listQueue({ limit: 1000 }));
    const funding = report.find((r) => r.finder === "post-funding")!;
    expect(funding.rows).toBe(1);
    expect(funding.scored).toBe(0);
    expect(Object.values(funding.buckets).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
