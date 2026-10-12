import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSharedDb } from "@oneshot-gtm/core";
import { commandLinkedInImportTouched } from "../src/commands/linkedin.ts";

describe("linkedin import-touched", () => {
  let dir: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "import-touched-"));
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      out += String(s);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      out += String(s);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the three counts, lists rejects with --verbose, and re-running is a no-op", async () => {
    const file = join(dir, "touched.csv");
    writeFileSync(
      file,
      "profile_url\nhttps://www.linkedin.com/in/cli-one\nhttps://github.com/cli-two\nhttps://uk.linkedin.com/in/cli-three/en\n",
    );
    await commandLinkedInImportTouched(file, { verbose: true, source: "other-tool" });
    expect(out).toContain("imported 2 · already present 0 · not a LinkedIn profile 1");
    expect(out).toContain("rejected: https://github.com/cli-two");
    expect(getSharedDb().linkedInTouch("cli-one")?.source).toBe("import:other-tool");

    out = "";
    await commandLinkedInImportTouched(file, {});
    expect(out).toContain("imported 0 · already present 2 · not a LinkedIn profile 1");
    expect(out).not.toContain("rejected:");
  });

  it("--dry-run reports without writing, and a bad invocation is refused", async () => {
    const file = join(dir, "touched.json");
    writeFileSync(file, JSON.stringify(["https://www.linkedin.com/in/cli-dry"]));
    await commandLinkedInImportTouched(file, { dryRun: true });
    expect(out).toContain("imported 1");
    expect(getSharedDb().linkedInTouch("cli-dry")).toBeNull();

    await expect(commandLinkedInImportTouched(undefined, {})).rejects.toThrow(/--from-ledgers/);
    await expect(commandLinkedInImportTouched(file, { fromLedgers: true })).rejects.toThrow(
      /not both/,
    );
    await expect(commandLinkedInImportTouched(join(dir, "missing.csv"), {})).rejects.toThrow(
      /cannot read/,
    );
  });
});
