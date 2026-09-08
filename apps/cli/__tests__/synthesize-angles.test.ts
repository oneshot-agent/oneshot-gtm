import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// commandSynthesizeAngles wiring: selector → gather → synthesize → persist,
// with the same spend-ceiling / dry-run / breaker guards research-prospects
// has. Pure helpers (parseScopes/resolveCap) are already covered by
// research-prospects.test.ts; this exercises the command's own flow control.

interface Row {
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  source: string | null;
  source_profile_url: string | null;
  linkedin_url: string | null;
}

let rows: Row[] = [];
const setAngleCalls: Array<{ id: number; angle: string | null }> = [];
let circuitOpen = false;
let gatherCostUsd = 0.02;
let nextAngle: { hook: string } | null = { hook: "shipped v2" };
const gatherCalls: Array<{ id: number; allowPaidResearch?: boolean }> = [];
const synthesizeCalls: number[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      listProspectsForAngle: () => rows,
      setProspectAngle: (id: number, angle: string | null) => setAngleCalls.push({ id, angle }),
    }),
  };
});

vi.mock("@oneshot-gtm/find", () => ({
  isCircuitOpen: () => circuitOpen,
  gatherAngleEvidence: async (id: number, opts?: { allowPaidResearch?: boolean }) => {
    gatherCalls.push({ id, ...opts });
    return {
      dossierText: null,
      dossierResearched: false,
      queueSignal: null,
      github: null,
      webReadText: null,
      webReadResearched: false,
      replies: [],
      costUsd: gatherCostUsd,
      sources: [],
    };
  },
  synthesizePersonAngle: async (input: { prospect: { id: number } }) => {
    synthesizeCalls.push(input.prospect.id);
    return { angle: nextAngle, costUsd: 0 };
  },
}));

const { commandSynthesizeAngles } = await import("../src/commands/synthesize-angles.ts");

function row(id: number): Row {
  return {
    id,
    name: `Pat ${id}`,
    company: null,
    email: `pat${id}@x.dev`,
    source: "repo-interest",
    source_profile_url: `https://github.com/pat${id}`,
    linkedin_url: null,
  };
}

let stdout: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  rows = [row(1), row(2), row(3)];
  setAngleCalls.length = 0;
  gatherCalls.length = 0;
  synthesizeCalls.length = 0;
  circuitOpen = false;
  gatherCostUsd = 0.02;
  nextAngle = { hook: "shipped v2" };
  stdout = [];
  process.stdout.write = ((chunk: string) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  vi.clearAllMocks();
});

describe("commandSynthesizeAngles", () => {
  it("--dry-run spends nothing and writes nothing", async () => {
    await commandSynthesizeAngles({ dryRun: true, refresh: false });
    expect(gatherCalls).toHaveLength(0);
    expect(synthesizeCalls).toHaveLength(0);
    expect(setAngleCalls).toHaveLength(0);
    expect(stdout.join("")).toContain("dry run");
  });

  it("gathers, synthesizes, and persists an angle for every candidate", async () => {
    await commandSynthesizeAngles({ dryRun: false, refresh: false });
    expect(gatherCalls).toHaveLength(3);
    expect(synthesizeCalls).toHaveLength(3);
    expect(setAngleCalls).toHaveLength(3);
    expect(setAngleCalls[0]!.angle).toBe(JSON.stringify(nextAngle));
  });

  it("passes allowPaidResearch=false through to gatherAngleEvidence under --cheap", async () => {
    await commandSynthesizeAngles({ dryRun: false, refresh: false, cheap: true });
    expect(gatherCalls.every((c) => c.allowPaidResearch === false)).toBe(true);
  });

  it("does not persist when synthesis returns a null angle", async () => {
    nextAngle = null;
    await commandSynthesizeAngles({ dryRun: false, refresh: false });
    expect(setAngleCalls).toHaveLength(0);
    expect(stdout.join("")).toContain("no signal: 3");
  });

  it("respects --limit, capping candidates before any spend", async () => {
    await commandSynthesizeAngles({ dryRun: false, refresh: false, limit: 1 });
    expect(gatherCalls).toHaveLength(1);
  });

  it("stops at --max-cost-usd once the ceiling is crossed", async () => {
    gatherCostUsd = 1; // one row alone crosses a $0.5 ceiling
    // concurrency: 1 serializes the check — with the default concurrency the
    // cap can be exceeded by up to (concurrency - 1) in-flight calls, same as
    // research-prospects.ts's own documented accounting.
    await commandSynthesizeAngles({
      dryRun: false,
      refresh: false,
      maxCostUsd: 0.5,
      concurrency: 1,
    });
    expect(gatherCalls.length).toBeLessThan(3);
    expect(stdout.join("")).toContain("Stopped at the $0.50 ceiling");
  });

  it("halts remaining rows when the circuit breaker is open", async () => {
    circuitOpen = true;
    await commandSynthesizeAngles({ dryRun: false, refresh: false });
    expect(gatherCalls).toHaveLength(0);
    expect(stdout.join("")).toContain("Circuit breaker opened");
  });

  it("reports nothing to do when the selector returns no candidates", async () => {
    rows = [];
    await commandSynthesizeAngles({ dryRun: false, refresh: false });
    expect(stdout.join("")).toContain("Nothing to synthesize");
  });
});
