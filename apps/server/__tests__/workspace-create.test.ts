import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  loadRegistry,
  serviceWritePath,
  dashboardServiceNames,
} from "@oneshot-gtm/core";
import { buildFetchHandler } from "../src/server.ts";
import { _setLaunchSpawn, workspaceCreate } from "../src/api/workspace.ts";

let tmp: string;
const spawn = vi.fn();
const run = vi.fn(async (_command: string, _args: string[]) => {});
const req = (body: unknown) =>
  new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { host: "localhost" },
    body: JSON.stringify(body),
  });
const create = (body: unknown, platform: NodeJS.Platform = "linux") =>
  workspaceCreate(req(body), { platform, userHome: join(tmp, "user"), run });
const target = (platform: NodeJS.Platform, name = "acme") =>
  serviceWritePath(platform, join(tmp, "user"), dashboardServiceNames(name))!;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "workspace-create-"));
  vi.stubEnv("ONESHOT_GTM_WORKSPACES", join(tmp, "registry"));
  spawn.mockReset();
  run.mockReset().mockResolvedValue(undefined);
  _setLaunchSpawn(spawn);
});
afterEach(() => {
  _setLaunchSpawn();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/workspaces", () => {
  it.each(["linux", "darwin"] as const)(
    "creates a fresh initialized home and loads the %s service",
    async (platform) => {
      const parent = loadConfig();
      const res = await create({ name: "acme" }, platform);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        name: "acme",
        port: 3031,
        persistent: true,
        warning: null,
      });
      const entry = loadRegistry().workspaces["acme"]!;
      expect(entry.home).toBe(join(tmp, "registry", "acme"));
      const configPath = join(entry.home, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config).toMatchObject({
        founderName: null,
        productOneLiner: null,
        emailIdentities: null,
        llmProvider: "openrouter",
      });
      expect(config.clientId).toBeTruthy();
      expect(config.clientId).not.toBe(parent.clientId);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(entry.home, ".env"))).toBe(false);
      expect(loadConfig()).toEqual(parent);
      const service = readFileSync(target(platform), "utf8");
      expect(service).toContain(entry.home);
      expect(service).toContain("3031");
      expect(service).toContain("--no-env-file");
      expect(service).toContain("ONESHOT_GTM_WORKSPACES");
      expect(service).toContain("ONESHOT_GTM_NO_BROWSER");
      expect(service).toContain("/apps/server/src/bin.ts");
      expect(run.mock.calls).toEqual(
        platform === "darwin"
          ? [
              ["launchctl", ["list"]],
              ["launchctl", ["load", target(platform)]],
            ]
          : [
              ["systemctl", ["--user", "show-environment"]],
              ["systemctl", ["--user", "daemon-reload"]],
              ["systemctl", ["--user", "enable", "--now", "oneshot-gtm-workspace-acme.service"]],
            ],
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicates while concurrent creates reserve distinct ports", async () => {
    const results = await Promise.all([
      create({ name: "acme" }),
      create({ name: "beta" }),
      create({ name: "acme" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 409]);
    expect(loadRegistry().workspaces["acme"]!.port).toBe(3031);
    expect(loadRegistry().workspaces["beta"]!.port).toBe(3032);
    expect((await results[2]!.json()).error).toContain("already exists");
    expect((await create({ name: "default" })).status).toBe(409);
  });

  it("rejects malformed bodies and names with the CLI's exact rules before writing", async () => {
    for (const body of [
      null,
      {},
      { name: 3 },
      { name: "" },
      { name: "Acme" },
      { name: " acme " },
      { name: "../acme" },
      { name: "é" },
      { name: "a".repeat(33) },
    ]) {
      expect((await create(body)).status, JSON.stringify(body)).toBe(400);
    }
    const malformed = new Request("http://localhost/api/workspaces", {
      method: "POST",
      headers: { host: "localhost" },
      body: "{",
    });
    expect((await buildFetchHandler()(malformed)).status).toBe(400);
    const crossSite = req({ name: "acme" });
    crossSite.headers.set("origin", "https://untrusted.example");
    expect((await buildFetchHandler()(crossSite)).status).toBe(403);
    expect(Object.keys(loadRegistry().workspaces)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)(
    "falls back to the existing spawn path when %s has no user manager",
    async (platform) => {
      run.mockRejectedValue(new Error("no user bus"));
      const res = await create({ name: "acme" }, platform);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        name: "acme",
        port: 3031,
        persistent: false,
        warning: expect.stringContaining("won't survive a reboot"),
      });
      expect(spawn).toHaveBeenCalledExactlyOnceWith({
        binPath: expect.stringMatching(/apps\/server\/src\/bin.ts$/),
        env: expect.objectContaining({
          ONESHOT_GTM_HOME: join(tmp, "registry", "acme"),
          ONESHOT_GTM_WORKSPACE: "acme",
          PORT: "3031",
          ONESHOT_GTM_NO_BROWSER: "1",
        }),
      });
      expect(existsSync(target("linux"))).toBe(false);
    },
  );

  it("rolls back a failed activation so creation can be retried", async () => {
    run.mockImplementation(async (_command, args) => {
      if (args.includes("enable")) throw new Error("activation failed");
    });
    const res = await create({ name: "acme" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "activation failed" });
    expect(run).toHaveBeenCalledWith("systemctl", [
      "--user",
      "disable",
      "--now",
      "oneshot-gtm-workspace-acme.service",
    ]);
    expect(existsSync(target("linux"))).toBe(false);
    expect(existsSync(join(tmp, "registry", "acme"))).toBe(false);
    expect(loadRegistry().workspaces["acme"]).toBeUndefined();
    run.mockResolvedValue(undefined);
    expect((await create({ name: "acme" })).status).toBe(201);
  });

  it("retains a potentially running service and home if unloading also fails", async () => {
    run.mockImplementation(async (_command, args) => {
      if (args.includes("enable") || args.includes("disable")) throw new Error("manager failed");
    });
    const res = await create({ name: "acme" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      name: "acme",
      port: 3031,
      error: expect.stringContaining("workspace retained"),
    });
    expect(existsSync(target("linux"))).toBe(true);
    expect(existsSync(join(loadRegistry().workspaces["acme"]!.home, "config.json"))).toBe(true);
  });

  it("rolls back when the unsupervised spawn fails", async () => {
    spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const res = await create({ name: "acme" }, "win32");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "spawn failed" });
    expect(loadRegistry().workspaces["acme"]).toBeUndefined();
    expect(existsSync(join(tmp, "registry", "acme"))).toBe(false);
  });
});
