import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LIVE_TREE_TIMEOUT_MS = 60_000;

let home: string;
let stdout: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gtm-measure-bench-"));
  process.env["ONESHOT_GTM_HOME"] = home;
  process.env["ONESHOT_GTM_CLI_NO_PARSE"] = "1";
  process.env["ONESHOT_GTM_TELEMETRY"] = "0";
  stdout = [];
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(
      (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | undefined) => void),
        callback?: (error?: Error | undefined) => void,
      ) => {
        stdout.push(String(chunk));
        if (typeof encodingOrCallback === "function") encodingOrCallback();
        else callback?.();
        return true;
      },
    );
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  const { setJsonMode } = await import("../src/output.ts");
  setJsonMode(false);
  rmSync(home, { recursive: true, force: true });
  delete process.env["ONESHOT_GTM_HOME"];
  delete process.env["ONESHOT_GTM_TELEMETRY"];
});

describe("measure benchmark through the commander tree", () => {
  it(
    "still emits JSON for `measure benchmark --json` although `measure` declares --json too",
    async () => {
      const { program } = await import("../src/index.ts");
      await program.parseAsync(["node", "oneshot-gtm", "measure", "benchmark", "--json"]);

      const parsed = JSON.parse(stdout.join("").trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({ status: "opted-out" });
    },
    LIVE_TREE_TIMEOUT_MS,
  );
});
