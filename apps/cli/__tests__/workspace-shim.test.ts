import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@oneshot-gtm/core/workspaces";

// End-to-end: the bootstrap shim must pick the workspace BEFORE core loads.
// Spawns the real CLI entrypoint in a child with an isolated registry.

const MAIN = resolve(import.meta.dirname, "../src/main.ts");

let wsDir: string;
beforeEach(() => {
  wsDir = mkdtempSync(join(tmpdir(), "oneshot-shim-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = wsDir;
});
afterEach(() => {
  delete process.env["ONESHOT_GTM_WORKSPACES"];
  rmSync(wsDir, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extraEnv })) {
    if (typeof v === "string") env[k] = v;
  }
  // The child must decide its own home: don't leak the test runner's.
  delete env["ONESHOT_GTM_HOME"];
  delete env["ONESHOT_GTM_WORKSPACE"];
  for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) env[k] = v;
  env["ONESHOT_GTM_WORKSPACES"] = wsDir;
  env["ONESHOT_GTM_SHARED"] = join(wsDir, "shared");
  env["ONESHOT_GTM_TELEMETRY"] = "0";
  const out = Bun.spawnSync(["bun", MAIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return {
    code: out.exitCode,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

describe("workspace bootstrap shim", () => {
  it("--workspace selects the named home before core loads", () => {
    const entry = createWorkspace("gtm");
    const r = run(["--workspace", "gtm", "workspace", "current"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`gtm\t${entry.home}`);
  });

  it("ONESHOT_GTM_WORKSPACE selects it too, and the flag wins over the env", () => {
    createWorkspace("gtm");
    createWorkspace("sdk");
    expect(run(["workspace", "current"], { ONESHOT_GTM_WORKSPACE: "sdk" }).stdout).toMatch(
      /^sdk\t/,
    );
    expect(
      run(["--workspace", "gtm", "workspace", "current"], { ONESHOT_GTM_WORKSPACE: "sdk" }).stdout,
    ).toMatch(/^gtm\t/);
  });

  it("an unknown workspace fails fast with exit 2 and a legible message", () => {
    const r = run(["--workspace", "nope", "doctor"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no workspace named 'nope'");
  });

  it("an explicit ONESHOT_GTM_HOME wins, and conflicts with --workspace", () => {
    createWorkspace("gtm");
    const home = join(wsDir, "explicit");
    expect(run(["workspace", "current"], { ONESHOT_GTM_HOME: home }).stdout.trim()).toBe(
      `explicit\t${home}`,
    );
    const r = run(["--workspace", "gtm", "workspace", "current"], { ONESHOT_GTM_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("conflicts");
  });
});
