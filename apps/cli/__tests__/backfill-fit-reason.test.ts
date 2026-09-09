import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@oneshot-gtm/core";

// Issue #592. A real ledger on a temp file; the only paid call is mocked.

let ledger: Ledger;
let icpOneLiner: string | null = "technical founders selling B2B software";
const generateMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ ...actual.loadConfig(), icpOneLiner }),
  };
});
vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return { ...actual, generateFitReason: generateMock };
});
vi.mock("../src/output.ts", () => ({
  c: { dim: (s: string) => s },
  header: () => {},
  note: () => {},
  ok: () => {},
  warn: () => {},
}));

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { commandBackfillFitReason, resolveCap } =
  await import("../src/commands/backfill-fit-reason.ts");

let dbPath: string;
beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-fit-reason-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new RealLedger(dbPath);
  icpOneLiner = "technical founders selling B2B software";
  generateMock.mockReset();
  generateMock.mockResolvedValue("Generated sentence about fit.");
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
  extra: { notes?: string; status?: "approved" | "sent" | "rejected" } = {},
): number {
  const id = ledger.enqueueTarget({
    playName,
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: `find:${playName}`,
    ...(extra.notes ? { notes: extra.notes } : {}),
    ...(extra.status === "rejected" ? { initialStatus: "rejected" as const } : {}),
  })!;
  if (extra.status === "approved") ledger.setQueueStatus({ id, status: "approved" });
  if (extra.status === "sent") {
    ledger.setQueueStatus({ id, status: "approved" });
    ledger.setQueueStatus({ id, status: "sent" });
  }
  return id;
}
const payloadOf = (id: number) =>
  JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;

const R = "Early-stage vertical SaaS using AI for document intelligence, fitting the ICP.";

describe("resolveCap", () => {
  it("never widens a run on a bad limit", () => {
    expect(resolveCap(undefined)).toBeUndefined();
    expect(resolveCap(Number.NaN)).toBe(0);
    expect(resolveCap(3.7)).toBe(3);
  });
});

describe("commandBackfillFitReason", () => {
  it("dry run resolves through the ladder but writes nothing", async () => {
    const a = enqueue(
      "accelerator-batch",
      { cohort: "yc-s26" },
      { notes: `YC Summer 2026 — ${R}` },
    );
    const b = enqueue("luma-events", {
      icpVerdict: "pass",
      icpVerdictReason: "CTO of a B2B startup.",
    });
    const g = enqueue("sources-sought", { title: "Cloud migration", agency: "GSA" });
    const s = await commandBackfillFitReason({ write: false, refresh: false, generate: true });
    expect(s).toMatchObject({
      eligible: 3,
      fromNotes: 1,
      fromPersonGate: 1,
      generated: 1,
      written: 0,
    });
    expect(generateMock).toHaveBeenCalledTimes(1);
    for (const id of [a, b, g]) expect(payloadOf(id)["fitReason"]).toBeUndefined();
  });

  it("--write persists with the right source, and a second run is a no-op", async () => {
    const a = enqueue(
      "accelerator-batch",
      { cohort: "yc-s26" },
      { notes: `YC Summer 2026 — ${R}` },
    );
    const b = enqueue("luma-events", {
      icpVerdict: "pass",
      icpVerdictReason: "CTO of a B2B startup.",
    });
    const g = enqueue("sources-sought", { title: "Cloud migration", agency: "GSA" });
    const first = await commandBackfillFitReason({ write: true, refresh: false, generate: true });
    expect(first.written).toBe(3);
    expect(payloadOf(a)).toMatchObject({
      fitReason: R,
      fitReasonSource: "notes",
      cohort: "yc-s26",
    });
    expect(payloadOf(b)).toMatchObject({
      fitReason: "CTO of a B2B startup.",
      fitReasonSource: "person-gate",
    });
    expect(payloadOf(g)).toMatchObject({
      fitReason: "Generated sentence about fit.",
      fitReasonSource: "generated",
    });

    generateMock.mockClear();
    const second = await commandBackfillFitReason({ write: true, refresh: false, generate: true });
    expect(second).toMatchObject({ alreadyHad: 3, written: 0 });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("the person-gate rung drops the gates' canned non-reasons like the notes rung does", async () => {
    const deferred = enqueue("luma-events", {
      icpVerdict: "unclear",
      icpVerdictReason: "no role text at discovery; deferred to enrichment",
    });
    const wrapped = enqueue("luma-events", {
      icpVerdict: "pass",
      icpVerdictReason: "unclear-after-enrich: Runs GTM at a seed-stage B2B startup.",
    });
    const s = await commandBackfillFitReason({ write: true, refresh: false, generate: false });
    expect(payloadOf(deferred)["fitReason"]).toBeUndefined();
    expect(payloadOf(wrapped)).toMatchObject({
      fitReason: "Runs GTM at a seed-stage B2B startup.",
      fitReasonSource: "person-gate",
    });
    expect(s).toMatchObject({ fromPersonGate: 1, unresolved: 1, written: 1 });
  });

  it("--refresh re-derives; a reject verdict is never promoted; sent rows are never touched", async () => {
    const kept = enqueue("show-hn", { fitReason: "old", fitReasonSource: "notes" }, { notes: R });
    const rejected = enqueue("luma-events", {
      icpVerdict: "reject",
      icpVerdictReason: "Recruiter.",
    });
    const sent = enqueue("show-hn", {}, { notes: R, status: "sent" });
    const s = await commandBackfillFitReason({ write: true, refresh: true, generate: false });
    expect(payloadOf(kept)).toMatchObject({ fitReason: R, fitReasonSource: "notes" });
    expect(payloadOf(rejected)["fitReason"]).toBeUndefined();
    expect(payloadOf(sent)["fitReason"]).toBeUndefined();
    expect(s.eligible).toBe(2); // the sent row is structurally out of scope
    expect(s.unresolved).toBe(1); // the reject row, with generation off
  });

  it("a row that gets sent between listing and writing is counted as race-skipped", async () => {
    const id = enqueue("show-hn", {}, { notes: R, status: "approved" });
    // Simulate the race: the drain claims it right before our write lands.
    const realPatch = ledger.patchLiveQueuePayload.bind(ledger);
    vi.spyOn(ledger, "patchLiveQueuePayload").mockImplementation((input) => {
      ledger.setQueueStatus({ id, status: "sent" });
      return realPatch(input);
    });
    const s = await commandBackfillFitReason({ write: true, refresh: false, generate: false });
    expect(s).toMatchObject({ raceSkipped: 1, written: 0 });
    expect(payloadOf(id)["fitReason"]).toBeUndefined();
  });

  it("--max-cost stops generation but not the free rungs; no ICP means no generation", async () => {
    enqueue("sources-sought", { title: "A", agency: "GSA" });
    enqueue("sources-sought", { title: "B", agency: "GSA" });
    enqueue("show-hn", {}, { notes: R });
    const capped = await commandBackfillFitReason({
      write: false,
      refresh: false,
      generate: true,
      maxCostUsd: 0.001,
    });
    expect(capped).toMatchObject({ generated: 1, unresolved: 1, fromNotes: 1 });

    icpOneLiner = null;
    generateMock.mockClear();
    const noIcp = await commandBackfillFitReason({ write: false, refresh: false, generate: true });
    expect(noIcp.noIcp).toBe(2);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("--limit caps the rows touched; an unknown --play throws rather than widening", async () => {
    for (let i = 0; i < 4; i++) enqueue("show-hn", {}, { notes: R });
    const s = await commandBackfillFitReason({
      write: true,
      refresh: false,
      generate: false,
      limit: 2,
    });
    expect(s.written).toBe(2);
    await expect(
      commandBackfillFitReason({
        write: false,
        refresh: false,
        generate: false,
        play: "typo-play",
      }),
    ).rejects.toThrow(/unknown --play/);
  });
});
