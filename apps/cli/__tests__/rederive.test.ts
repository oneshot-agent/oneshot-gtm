import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@oneshot-gtm/core";

// `find rederive`: re-derive this workspace's edge and verdicts for rows moved
// in from another workspace. A real ledger on a temp file; the per-row work
// (queue-rederive.ts, tested in packages/find) is stubbed to record its calls.

let ledger: Ledger;
const calls: Array<{ id: number; dryRun: boolean }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger };
});
vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return {
    ...actual,
    rederiveQueueRow: async (_l: unknown, id: number, opts: { dryRun?: boolean } = {}) => {
      calls.push({ id, dryRun: opts.dryRun === true });
      return { ok: true, patch: { yourEdgeSource: "none" } };
    },
  };
});
vi.mock("../src/output.ts", () => ({
  c: { dim: (s: string) => s },
  header: () => {},
  note: () => {},
  ok: () => {},
  warn: () => {},
}));

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { commandRederive, movedOpenRowIds } = await import("../src/commands/rederive.ts");

let dbPath: string;
beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-rederive-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new RealLedger(dbPath);
  calls.length = 0;
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

const movedFrom = { workspace: "other", queueId: 1, at: "2026-10-05T00:00:00Z" };
function enqueue(payload: Record<string, unknown>, status?: "approved" | "rejected"): number {
  const id = ledger.enqueueTarget({
    playName: "design-partner-loi",
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:list-page:runs-x",
    ...(status === "rejected" ? { initialStatus: "rejected" as const } : {}),
  })!;
  if (status === "approved") ledger.setQueueStatus({ id, status: "approved" });
  return id;
}

describe("find rederive", () => {
  it("--moved picks only open rows that arrived through a move", async () => {
    const pending = enqueue({ name: "A", movedFrom });
    const approved = enqueue({ name: "B", movedFrom }, "approved");
    enqueue({ name: "C", movedFrom }, "rejected");
    enqueue({ name: "D" });
    expect(movedOpenRowIds()).toEqual([pending, approved]);
    await commandRederive({ moved: true, dryRun: true });
    expect(calls).toEqual([
      { id: pending, dryRun: true },
      { id: approved, dryRun: true },
    ]);
  });

  it("--id runs one row", async () => {
    const id = enqueue({ name: "A", movedFrom });
    await commandRederive({ id, moved: false, dryRun: false });
    expect(calls).toEqual([{ id, dryRun: false }]);
  });

  it("needs exactly one of --id or --moved", async () => {
    await expect(commandRederive({ moved: false, dryRun: false })).rejects.toThrow(/exactly one/);
    await expect(commandRederive({ id: 1, moved: true, dryRun: false })).rejects.toThrow(
      /exactly one/,
    );
  });
});
