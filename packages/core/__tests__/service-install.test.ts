import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fails the next service-file write after `wx` has created the file, the way a
// full disk does.
const failNextWrite = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  const writeFileSync: typeof real.writeFileSync = (file, data, options) => {
    if (failNextWrite.code) {
      const code = failNextWrite.code;
      failNextWrite.code = null;
      real.writeFileSync(file, "", options);
      throw Object.assign(new Error(`${code}: write failed`), { code });
    }
    return real.writeFileSync(file, data, options);
  };
  return { ...real, writeFileSync, default: { ...real, writeFileSync } };
});

const {
  BASE_PORT,
  dashboardService,
  dashboardServiceNames,
  installDashboardService,
  serviceWritePath,
} = await import("../src/index.ts");

let tmp: string;
const run = vi.fn(async (_command: string, _args: string[]) => {});
const spec = () =>
  dashboardService({
    bunBin: "/usr/local/bin/bun",
    serverEntry: "/repo/apps/server/src/bin.ts",
    home: join(tmp, "home"),
    workspace: "acme",
    port: BASE_PORT + 1,
  });
const target = () => serviceWritePath("linux", join(tmp, "user"), dashboardServiceNames("acme"))!;
const install = () =>
  installDashboardService(spec(), { platform: "linux", userHome: join(tmp, "user"), run });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "service-install-"));
  run.mockReset().mockResolvedValue(undefined);
  failNextWrite.code = null;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("installDashboardService", () => {
  it("removes a partial service file it created so a retry can write it", async () => {
    failNextWrite.code = "ENOSPC";
    await expect(install()).rejects.toThrow("ENOSPC");
    expect(existsSync(target())).toBe(false);
    expect(await install()).toBe(true);
    expect(readFileSync(target(), "utf8")).toContain("ExecStart=");
  });

  it("leaves an existing service file in place", async () => {
    expect(await install()).toBe(true);
    const before = readFileSync(target(), "utf8");
    await expect(install()).rejects.toThrow(/EEXIST/);
    expect(readFileSync(target(), "utf8")).toBe(before);
  });
});
