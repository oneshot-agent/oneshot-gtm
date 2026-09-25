import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Opening a state DB heals it to 0600; doctor reports one that stayed readable
// (e.g. owned by another user, so the chmod failed).

let home: string;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    configDir: () => home,
    sharedDbPath: () => join(home, "shared.sqlite"),
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
  home = mkdtempSync(join(tmpdir(), "oneshot-doctor-perms-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("database permissions check", () => {
  it("warns about a ledger other users can read", async () => {
    const ledger = join(home, "ledger.sqlite");
    writeFileSync(ledger, "");
    chmodSync(ledger, 0o644);
    const check = (await runDoctor()).find((r) => r.name === "database permissions");
    expect(check).toMatchObject({ severity: "warn", hint: `chmod 600 ${ledger}` });
    expect(check!.message).toContain("mode 644");
  });

  it("stays quiet for owner-only files", async () => {
    for (const name of ["ledger.sqlite", "shared.sqlite"]) {
      writeFileSync(join(home, name), "");
      chmodSync(join(home, name), 0o600);
    }
    const results = await runDoctor();
    expect(results.find((r) => r.name === "database permissions")).toBeUndefined();
  });
});
