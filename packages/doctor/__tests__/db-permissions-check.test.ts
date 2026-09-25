import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Opening a state DB heals it to 0600; doctor reports any database file (main,
// -wal or -shm; any workspace or the shared directory) that stayed readable.

let home: string;
let shared: string;
let other: string;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    configDir: () => home,
    sharedDir: () => shared,
    sharedDbPath: () => join(shared, "shared.sqlite"),
    // Never the real registry: the test must not stat the user's ledgers.
    listWorkspaces: () => [
      ["default", { home, port: 3030, createdAt: "" }],
      ["other", { home: other, port: 3031, createdAt: "" }],
    ],
    oneshotEnvReady: () => false,
    // A stub, so opening the ledger doesn't heal the fixture file first.
    getLedger: () => ({
      listReceipts: () => [],
      compactReceiptPayloads: () => ({ rows: 0, bytesBefore: 0, bytesAfter: 0, skipped: 0 }),
    }),
  };
});

const { runDoctor } = await import("../src/check.ts");

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "oneshot-doctor-perms-"));
  home = join(root, "home");
  shared = join(root, "shared");
  other = join(root, "other");
  for (const d of [home, shared, other]) mkdirSync(d);
});
afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
});

function file(path: string, mode: number): string {
  writeFileSync(path, "");
  chmodSync(path, mode);
  return path;
}

async function permissionsCheck() {
  return (await runDoctor()).find((r) => r.name === "database permissions");
}

describe.runIf(process.platform !== "win32")("database permissions check", () => {
  it("warns about a ledger other users can read", async () => {
    const ledger = file(join(home, "ledger.sqlite"), 0o644);
    const check = await permissionsCheck();
    expect(check).toMatchObject({ severity: "warn", hint: `chmod 600 ${ledger}` });
    expect(check!.message).toContain(ledger);
  });

  it("covers other workspaces' ledgers, the shared stores and -wal/-shm files", async () => {
    file(join(home, "ledger.sqlite"), 0o600);
    const wal = file(join(home, "ledger.sqlite-wal"), 0o644);
    const otherLedger = file(join(other, "ledger.sqlite"), 0o640);
    const review = file(join(shared, "reply-review.sqlite"), 0o604);
    file(join(shared, "shared.sqlite"), 0o600);
    const check = await permissionsCheck();
    expect(check!.message).toContain("3 database file(s)");
    for (const path of [wal, otherLedger, review]) expect(check!.hint).toContain(path);
  });

  it("stays quiet when every database file is owner-only", async () => {
    file(join(home, "ledger.sqlite"), 0o600);
    file(join(home, "ledger.sqlite-shm"), 0o600);
    file(join(other, "ledger.sqlite"), 0o600);
    file(join(shared, "shared.sqlite"), 0o600);
    expect(await permissionsCheck()).toBeUndefined();
  });
});
