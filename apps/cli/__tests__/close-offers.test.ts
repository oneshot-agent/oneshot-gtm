import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@oneshot-gtm/core";

// `find close-offers`: a real ledger on a temp file. The sequence shape and
// the close-offer writer are mocked; the picker is the real one.

let ledger: Ledger;
const ensureMock = vi.fn();
let brief: string | undefined = "Acme closes open claims.";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ ...actual.loadConfig(), productBrief: brief }),
  };
});
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    // Two emails, then the LinkedIn continuation: the close is step 4.
    effectiveSequence: (playName: string) => ({
      playName,
      steps: [
        { id: "email:1", channel: "email", dayOffset: 3 },
        { id: "email:2", channel: "email", dayOffset: 3 },
        { id: "linkedin:invite", channel: "linkedin", dayOffset: 3 },
        { id: "linkedin:1", channel: "linkedin", dayOffset: 3 },
        { id: "linkedin:2", channel: "linkedin", dayOffset: 3 },
      ],
    }),
    ensureCloseOffer: ensureMock,
  };
});
vi.mock("../src/output.ts", async (importOriginal) => {
  const { resolveCap } = await importOriginal<typeof import("../src/output.ts")>();
  return {
    c: { dim: (s: string) => s },
    header: () => {},
    ok: () => {},
    resolveCap,
    warn: () => {},
  };
});

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { commandCloseOffers } = await import("../src/commands/close-offers.ts");

const PLAY = "design-partner-loi";
const offer = (text: string, relevance = "relevant") => ({
  offer: text,
  steps: "does it",
  evidence: [],
  stage: "startup",
  level: "role",
  relevance,
  version: "offer-v9",
  inputHash: "h",
  derivedAt: "2026-11-01T00:00:00Z",
});

let dbPath: string;
let n = 0;
beforeEach(() => {
  dbPath = join(tmpdir(), `oneshot-gtm-close-offers-${Date.now()}-${++n}.sqlite`);
  ledger = new RealLedger(dbPath);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  ensureMock.mockReset();
  brief = "Acme closes open claims.";
  ensureMock.mockImplementation(async () => ({ status: "written", offer: offer("new") }));
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

/** An active sequence at `step` carrying `active`, ranked ahead of `others`; `emailed` sends its intro. */
function sequence(opts: { step: number; others: string[]; emailed?: boolean }): number {
  const id = ledger.upsertProspect({ name: "Dana", email: `dana${++n}@example.com` });
  if (opts.emailed !== false) {
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "s", body: "b" },
    });
  }
  const active = offer("get every open claim closed this quarter");
  ledger.enrollCadence({
    prospectId: id,
    playName: PLAY,
    nextDueAt: "2026-11-20T00:00:00Z",
    offer: {
      offer: active,
      candidates: [active, ...opts.others.map((o) => offer(o))],
      origin: "intro",
    },
  });
  if (opts.step > 0) {
    ledger.advanceCadence({
      prospectId: id,
      playName: PLAY,
      newStep: opts.step,
      nextDueAt: "2026-11-20T00:00:00Z",
    });
  }
  return id;
}

describe("find close-offers", () => {
  it("--dry-run counts picks and writes, calls no model and writes nothing", async () => {
    const spare = sequence({ step: 2, others: ["get every supplier contract renewed on time"] });
    const bare = sequence({ step: 4, others: [] });
    sequence({ step: 5, others: [] }); // the close already went
    sequence({ step: 1, others: [], emailed: false });
    const before = ledger.getCadence(spare, PLAY)!.offer_json;

    const out = await commandCloseOffers({ dryRun: true });
    expect(out.eligible).toBe(2);
    expect(out.picked).toEqual([`sequence ${spare}/${PLAY}`]);
    expect(out.written).toEqual([`sequence ${bare}/${PLAY}`]);
    expect(ensureMock).not.toHaveBeenCalled();
    expect(ledger.getCadence(spare, PLAY)!.offer_json).toBe(before);
  });

  it("runs ensureCloseOffer on each eligible sequence and sums the cost", async () => {
    const a = sequence({ step: 0, others: [] });
    const b = sequence({ step: 3, others: [] });
    ensureMock.mockImplementation(
      async (input: { prospectId: number; onCost?: (n: number) => void }) => {
        input.onCost?.(0.02);
        return input.prospectId === a
          ? { status: "written", offer: offer("new") }
          : { status: "none", reason: "skipped" };
      },
    );
    const out = await commandCloseOffers({ dryRun: false });
    expect(ensureMock).toHaveBeenCalledTimes(2);
    expect(out.written).toEqual([`sequence ${a}/${PLAY}`]);
    expect(out.none).toEqual([`sequence ${b}/${PLAY}`]);
    expect(out.costUsd).toBeCloseTo(0.04);
  });

  it("leaves settled sequences out before --limit, so a capped run moves on", async () => {
    const settled = sequence({ step: 2, others: ["get every supplier contract renewed on time"] });
    const next = sequence({ step: 2, others: [] });
    const r = ledger.getCadence(settled, PLAY)!;
    const stored = JSON.parse(r.offer_json!) as { offer: { offer: string }; candidates: unknown[] };
    expect(
      ledger.setCadenceCloseOffer({
        prospectId: settled,
        playName: PLAY,
        activeOffer: stored.offer.offer,
        close: stored.candidates[1] as Record<string, unknown>,
      }),
    ).toBe(true);
    const out = await commandCloseOffers({ dryRun: true, limit: 1 });
    expect(out).toMatchObject({ eligible: 2, settled: 1, written: [`sequence ${next}/${PLAY}`] });
  });

  it("--dry-run counts nothing to write when there is no product brief", async () => {
    brief = undefined;
    sequence({ step: 2, others: [] });
    const out = await commandCloseOffers({ dryRun: true });
    expect(out).toMatchObject({ eligible: 1, settled: 1, written: [] });
  });
});
