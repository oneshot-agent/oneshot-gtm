import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The workspace routes are what let the dashboard (a) name the workspace it
// serves and (b) open/auto-start any other one. Identity comes from env
// (ONESHOT_GTM_WORKSPACE, PORT), the roster from the registry — pointed at a
// temp dir here via ONESHOT_GTM_WORKSPACES so the real registry is never read.

const tmp = mkdtempSync(join(tmpdir(), "oneshot-ws-route-"));
const gtmHome = join(tmp, "gtm");
mkdirSync(gtmHome, { recursive: true });
writeFileSync(
  join(tmp, "registry.json"),
  JSON.stringify({
    default: "default",
    workspaces: { gtm: { home: gtmHome, port: 3999, createdAt: "2026-08-24T00:00:00Z" } },
  }),
);
process.env["ONESHOT_GTM_WORKSPACES"] = tmp;
process.env["ONESHOT_GTM_WORKSPACE"] = "default";
process.env["PORT"] = "3030";

// Liveness probes must never hit the network in tests.
const fetchMock = vi.fn(async () => {
  throw new Error("down");
});
vi.stubGlobal("fetch", fetchMock);

const { workspaceInfo, workspaceLaunch, _setLaunchSpawn } = await import("../src/api/workspace.ts");

const launchRequest = (body: unknown) =>
  new Request("http://x/api/workspace/launch", {
    method: "POST",
    body: JSON.stringify(body),
  });

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockClear();
  _setLaunchSpawn();
});

describe("GET /api/workspace", () => {
  it("names the current workspace and synthesizes the implicit default entry", async () => {
    const res = await workspaceInfo(new Request("http://x/api/workspace"));
    const out = (await res.json()) as {
      current: { name: string; port: number };
      workspaces: Array<{ name: string; port: number; isCurrent: boolean; running: boolean }>;
    };
    expect(out.current.name).toBe("default");
    expect(out.current.port).toBe(3030);

    const names = out.workspaces.map((w) => w.name);
    expect(names).toEqual(["default", "gtm"]);

    const self = out.workspaces.find((w) => w.name === "default")!;
    // Current is running by definition — no self-probe.
    expect(self.isCurrent).toBe(true);
    expect(self.running).toBe(true);

    const gtm = out.workspaces.find((w) => w.name === "gtm")!;
    expect(gtm.port).toBe(3999);
    expect(gtm.running).toBe(false); // probe rejected above
  });
});

describe("POST /api/workspace/launch", () => {
  it("400s on the current workspace — switching to yourself is a no-op", async () => {
    const res = await workspaceLaunch(launchRequest({ name: "default" }));
    expect(res.status).toBe(400);
  });

  it("404s on an unknown name", async () => {
    const res = await workspaceLaunch(launchRequest({ name: "nope" }));
    expect(res.status).toBe(404);
  });

  it("400s on a malformed body", async () => {
    const res = await workspaceLaunch(launchRequest({}));
    expect(res.status).toBe(400);
  });

  it("spawns the target bound to its registered home + port, browser suppressed", async () => {
    const spawns: Array<{ binPath: string; env: Record<string, string | undefined> }> = [];
    _setLaunchSpawn((opts) => spawns.push(opts));

    const res = await workspaceLaunch(launchRequest({ name: "gtm" }));
    const out = (await res.json()) as { status: string; port: number };
    expect(out).toEqual({ status: "starting", port: 3999 });

    expect(spawns).toHaveLength(1);
    const { binPath, env } = spawns[0]!;
    expect(binPath).toMatch(/bin\.ts$/);
    expect(env["ONESHOT_GTM_HOME"]).toBe(gtmHome);
    expect(env["ONESHOT_GTM_WORKSPACE"]).toBe("gtm");
    expect(env["PORT"]).toBe("3999");
    expect(env["ONESHOT_GTM_NO_BROWSER"]).toBe("1");
    // A dev-mode parent must not leak its vite URL — the child would 302 the
    // whole UI to the wrong workspace's dev server.
    expect(env["VITE_DEV_SERVER_URL"]).toBeUndefined();
  });

  it("reports already-running instead of double-spawning when the probe succeeds", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }) as never);
    const spawns: unknown[] = [];
    _setLaunchSpawn((opts) => spawns.push(opts));

    const res = await workspaceLaunch(launchRequest({ name: "gtm" }));
    const out = (await res.json()) as { status: string };
    expect(out.status).toBe("already-running");
    expect(spawns).toHaveLength(0);
  });
});
