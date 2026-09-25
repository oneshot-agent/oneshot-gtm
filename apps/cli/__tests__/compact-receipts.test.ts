import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Ledger } from "@oneshot-gtm/core";

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger };
});
vi.mock("../src/output.ts", () => ({
  c: { dim: (s: string) => s },
  header: () => {},
  note: () => {},
  ok: () => {},
  warn: () => {},
}));

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { commandCompactReceipts } = await import("../src/commands/compact-receipts.ts");

let dbPath: string;
beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-compact-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new RealLedger(dbPath);
  const db = new Database(dbPath);
  const insert = db.prepare(
    "INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt) VALUES ('p', 'web.read', 0.01, ?)",
  );
  for (let i = 0; i < 40; i++) {
    insert.run(JSON.stringify({ url: `https://x${i}.test`, markdown: "x".repeat(51_200) }));
  }
  db.close();
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

describe("commandCompactReceipts", () => {
  it("dry run writes nothing and never vacuums", () => {
    const out = commandCompactReceipts({ apply: false, vacuum: true });
    expect(out).toMatchObject({ rows: 40, vacuumed: false, fileBytesAfter: null });
    expect(ledger.compactReceiptPayloads({ apply: false }).rows).toBe(40);
  });

  it("a later --apply still vacuums after a --no-vacuum trim", () => {
    const first = commandCompactReceipts({ apply: true, vacuum: false });
    expect(first).toMatchObject({ rows: 40, vacuumed: false });
    expect(ledger.freePages()).toBeGreaterThan(0);

    const retry = commandCompactReceipts({ apply: true, vacuum: true });
    expect(retry).toMatchObject({ rows: 0, vacuumed: true });
    expect(retry.fileBytesAfter!).toBeLessThan(retry.fileBytesBefore);
    expect(ledger.freePages()).toBe(0);

    // Nothing left to trim or reclaim: no VACUUM.
    expect(commandCompactReceipts({ apply: true, vacuum: true })).toMatchObject({
      rows: 0,
      vacuumed: false,
    });
  });
});
