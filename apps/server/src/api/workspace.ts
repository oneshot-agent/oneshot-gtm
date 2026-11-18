import { readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ENV_ONLY_SECRET_KEYS,
  SECRET_KEYS,
  WorkspaceError,
  ServiceRollbackError,
  assertValidName,
  createWorkspace,
  dashboardServerEntry,
  dashboardService,
  initializeWorkspaceHome,
  installDashboardService,
  removeWorkspace,
  sharedDir,
  workspacesDir,
  type WorkspaceEntry,
  currentWorkspaceName,
  listWorkspaces,
  loadRegistry,
} from "@oneshot-gtm/core";
import { configDir } from "@oneshot-gtm/core";
import type { WorkspaceInfo } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * Workspace identity + roster for the dashboard shell. Each workspace is a
 * hermetic install on its own port, so "switching" means opening another
 * server's tab. `running` is probed HERE, server-side, so the web app stays
 * same-origin and the switcher has a single polling surface.
 */

/** The port this server is bound to: bin.ts sets PORT to the port it chose. */
function boundPort(): number {
  const p = Number.parseInt(process.env["PORT"] ?? "3030", 10);
  return Number.isFinite(p) ? p : 3030;
}

/**
 * Who answered a workspace's port, by the name its `/api/health` carries:
 *  - `verified`: it named this workspace.
 *  - `unknown`: a 2xx answer with no name, as older builds send. Running,
 *    but never proof of identity.
 *  - `other`: it named a different workspace (`answeredAs`).
 *  - `stopped`: no answer within ~300ms, or a non-2xx one.
 */
export type WorkspaceProbe =
  | { state: "verified" | "unknown" | "stopped" }
  | { state: "other"; answeredAs: string };

/** ~300ms probe of `name`'s /api/health on `port`: is it up, and is it that workspace? */
export async function probeWorkspace(name: string, port: number): Promise<WorkspaceProbe> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(300),
    });
  } catch {
    return { state: "stopped" };
  }
  if (!res.ok) return { state: "stopped" };
  let answeredAs: unknown;
  try {
    answeredAs = ((await res.json()) as { workspace?: unknown } | null)?.workspace;
  } catch {
    // Not JSON, or the body outlived the timeout: something answered, unnamed.
  }
  if (typeof answeredAs !== "string" || !answeredAs) return { state: "unknown" };
  return answeredAs === name ? { state: "verified" } : { state: "other", answeredAs };
}

/** Why a workspace can't be started or reached: its port serves a different one. */
function portTakenError(name: string, port: number, answeredAs: string): string {
  return `port ${port} is registered to workspace "${name}" but workspace "${answeredAs}" is answering on it — stop that server, then try again`;
}

export async function workspaceInfo(req: Request): Promise<Response> {
  const name = currentWorkspaceName();
  const current = { name, home: configDir(), port: boundPort() };

  let roster: WorkspaceInfo["workspaces"];
  try {
    const reg = loadRegistry();
    const entries = listWorkspaces(reg);
    roster = await Promise.all(
      entries.map(async ([wsName, entry]) => {
        const isCurrent = wsName === name;
        // An unnamed answer (older build) still counts as running; a
        // different workspace on the port means this one is not.
        const state = isCurrent ? "verified" : (await probeWorkspace(wsName, entry.port)).state;
        return {
          name: wsName,
          home: entry.home,
          port: isCurrent ? current.port : entry.port,
          isCurrent,
          isDefault: wsName === reg.default,
          running: state === "verified" || state === "unknown",
          verified: state === "verified",
        };
      }),
    );
    // A server started with a bare ONESHOT_GTM_HOME (unregistered) won't match
    // any roster row: surface it so the badge never lies about identity.
    if (!roster.some((w) => w.isCurrent)) {
      roster.unshift({
        ...current,
        isCurrent: true,
        isDefault: false,
        running: true,
        verified: true,
      });
    }
  } catch (err) {
    if (!(err instanceof WorkspaceError)) throw err;
    // Corrupt registry: degrade to self-only rather than a 500. The badge
    // (identity) matters more than the switcher (roster).
    roster = [
      {
        ...current,
        isCurrent: true,
        isDefault: name === "default",
        running: true,
        verified: true,
      },
    ];
  }

  const body: WorkspaceInfo = { current, workspaces: roster };
  return jsonResponse(body, 200, req);
}

/**
 * Spawn function, injectable for tests. The real one detaches a child server
 * bound to the target workspace's home + registered port.
 */
export type LaunchSpawn = (opts: {
  binPath: string;
  env: Record<string, string | undefined>;
}) => void;

const realSpawn: LaunchSpawn = ({ binPath, env }) => {
  const proc = Bun.spawn([process.execPath, "--no-env-file", "run", binPath], {
    env,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();
};

let spawnFn: LaunchSpawn = realSpawn;
/** Test hook. Pass nothing to restore the real spawn. */
export function _setLaunchSpawn(fn?: LaunchSpawn): void {
  spawnFn = fn ?? realSpawn;
}

/** POST /api/workspaces: provision an independent home and start its dashboard. */
export async function workspaceCreate(
  req: Request,
  serviceOptions?: Parameters<typeof installDashboardService>[1],
): Promise<Response> {
  let name: string;
  try {
    const body = (await req.json()) as { name?: unknown } | null;
    if (typeof body?.name !== "string") throw new Error("body must be {name: string}");
    name = body.name;
    assertValidName(name);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400, req);
  }

  let entry: WorkspaceEntry;
  try {
    // The running dashboard's port may be unregistered (`--port`, PORT).
    entry = createWorkspace(name, { reservedPorts: [boundPort()] });
  } catch (err) {
    return jsonResponse(
      { error: (err as Error).message },
      err instanceof WorkspaceError ? 409 : 500,
      req,
    );
  }
  let initialConfig: string | null = null;
  try {
    initialConfig = initializeWorkspaceHome(entry.home);
    const spec = dashboardService({
      bunBin: process.execPath,
      serverEntry: dashboardServerEntry(),
      home: entry.home,
      workspace: name,
      port: entry.port,
    });
    spec.runtimeArgs = ["--no-env-file"];
    // Keep a relocated registry visible after reboot, too.
    if (process.env["ONESHOT_GTM_WORKSPACES"]) {
      spec.env.push(["ONESHOT_GTM_WORKSPACES", workspacesDir()]);
    }
    // And the shared database, which holds members and allowed hosts.
    if (process.env["ONESHOT_GTM_SHARED"]?.trim()) {
      spec.env.push(["ONESHOT_GTM_SHARED", resolve(sharedDir())]);
    }
    const persistent = await installDashboardService(spec, serviceOptions);
    if (!persistent) spawnWorkspace(name, entry);
    return jsonResponse(
      {
        name,
        port: entry.port,
        persistent,
        warning: persistent
          ? null
          : "No user service manager is available. This workspace's server won't survive a reboot.",
      },
      201,
      req,
    );
  } catch (err) {
    let error = (err as Error).message;
    if (!(err instanceof ServiceRollbackError)) {
      try {
        // A launch from the switcher can start this workspace's server while
        // the service is still being installed, and it can save settings or
        // open its ledger. Delete only what this request wrote and nothing
        // has touched since; otherwise keep the home.
        if (initialConfig !== null) assertUntouchedHome(entry.home, initialConfig);
        if (initialConfig !== null) unlinkSync(join(entry.home, "config.json"));
        // Never recursively delete a home: unexpected files mean it must be kept.
        rmdirSync(entry.home);
        removeWorkspace(name);
        return jsonResponse({ error }, 500, req);
      } catch (cleanup) {
        error += `; cleanup failed: ${(cleanup as Error).message}`;
      }
    }
    return jsonResponse(
      {
        error: `${error}; workspace retained — recover it from the switcher`,
        name,
        port: entry.port,
      },
      500,
      req,
    );
  }
}

/** Throw unless the home holds only the config.json this request wrote, unchanged. */
function assertUntouchedHome(home: string, initialConfig: string): void {
  const files = readdirSync(home);
  if (files.length !== 1 || files[0] !== "config.json") {
    throw new Error(`${home} has files the new workspace's server wrote`);
  }
  if (readFileSync(join(home, "config.json"), "utf8") !== initialConfig) {
    throw new Error(`${home}/config.json was saved after creation`);
  }
}

/**
 * POST /api/workspace/launch {name}: start another workspace's dashboard
 * server in the background. Deliberately unsupervised (no PID file, no
 * lifecycle management); the roster's `running` probe is the source of truth.
 */
export async function workspaceLaunch(req: Request): Promise<Response> {
  let name = "";
  try {
    const body = (await req.json()) as { name?: unknown };
    if (typeof body.name === "string") name = body.name.trim();
  } catch {
    // fall through to the empty-name guard
  }
  if (!name) return jsonResponse({ error: "body must be {name: string}" }, 400, req);
  if (name === currentWorkspaceName()) {
    return jsonResponse({ error: "already in this workspace" }, 400, req);
  }

  let entry: { home: string; port: number } | undefined;
  try {
    const found = listWorkspaces(loadRegistry()).find(([wsName]) => wsName === name);
    entry = found?.[1];
  } catch (err) {
    if (!(err instanceof WorkspaceError)) throw err;
    return jsonResponse({ error: `workspace registry unreadable: ${err.message}` }, 500, req);
  }
  if (!entry) {
    return jsonResponse({ error: `unknown workspace "${name}"` }, 404, req);
  }

  const answer = await probeWorkspace(name, entry.port);
  if (answer.state === "other") {
    // Spawning would only lose the bind, and the tab would open the wrong workspace.
    return jsonResponse({ error: portTakenError(name, entry.port, answer.answeredAs) }, 409, req);
  }
  if (answer.state !== "stopped") {
    return jsonResponse({ status: "already-running", port: entry.port }, 200, req);
  }

  spawnWorkspace(name, entry);

  return jsonResponse({ status: "starting", port: entry.port }, 200, req);
}

/** Detach a child server for `name` on its registered port. Unsupervised by design. */
function spawnWorkspace(name: string, entry: { home: string; port: number }): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ONESHOT_GTM_HOME: entry.home,
    ONESHOT_GTM_WORKSPACE: name,
    PORT: String(entry.port),
    // The child must not steal browser focus; the switcher opens the tab
    // itself once the health probe flips.
    ONESHOT_GTM_NO_BROWSER: "1",
  };
  // The parent may be running in dev mode; the child has no vite of its own
  // and must serve its static build instead of 302ing to the parent's.
  delete env["VITE_DEV_SERVER_URL"];
  // A sibling workspace must resolve its own keys and wallet. This process's
  // env already holds its own workspace's .env (applySecretsToEnv), and the
  // child's fill-blanks rule would keep those values and silently spend,
  // send or list on the wrong accounts. --no-env-file also prevents Bun from
  // reintroducing the repository's keys before config loads.
  for (const key of [...SECRET_KEYS, ...ENV_ONLY_SECRET_KEYS]) delete env[key];

  // fileURLToPath, not .pathname: a repo path with a space or non-ASCII char
  // would arrive percent-encoded and the child would die on a missing file.
  const binPath = dashboardServerEntry();
  spawnFn({ binPath, env });
}

/**
 * Another workspace by name. Never this one, never an unregistered one.
 * Synchronous, so a caller can validate a destination before it commits to
 * anything (a move reserves its row only after this passes).
 */
export function resolveOtherWorkspace(
  name: string,
):
  | { ok: true; entry: { home: string; port: number } }
  | { ok: false; status: number; error: string } {
  if (!name) return { ok: false, status: 400, error: "workspace name required" };
  if (name === currentWorkspaceName()) {
    return { ok: false, status: 400, error: "that is this workspace" };
  }
  let entry: { home: string; port: number } | undefined;
  try {
    const found = listWorkspaces(loadRegistry()).find(([wsName]) => wsName === name);
    entry = found?.[1];
  } catch (err) {
    if (!(err instanceof WorkspaceError)) throw err;
    return { ok: false, status: 500, error: `workspace registry unreadable: ${err.message}` };
  }
  if (!entry) return { ok: false, status: 404, error: `unknown workspace "${name}"` };
  return { ok: true, entry };
}

/**
 * Cold boot awaits two 60s cleanup retry windows, each of which can overrun
 * by SQLite's 5s busy timeout (boot-cleanup.ts). Allow 20s more for startup
 * and HTTP binding before a queue move gives up on the destination.
 */
const LAUNCH_WAIT_MS = 150_000;
const LAUNCH_POLL_MS = 500;

/**
 * Resolve another workspace by name and make sure its server answers: probe,
 * spawn if needed, poll until healthy. A port answering as a different
 * workspace is a 409, never a destination. The building block of a queue move:
 * the move route talks to the destination over its own HTTP API, so the
 * destination must be up. Never throws on a registry problem; every failure
 * is a message the route can return verbatim.
 */
export async function ensureWorkspaceRunning(
  name: string,
  opts: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<
  { ok: true; port: number; started: boolean } | { ok: false; status: number; error: string }
> {
  const resolved = resolveOtherWorkspace(name);
  if (!resolved.ok) return resolved;
  const { entry } = resolved;
  // A different workspace on the port must never receive this one's rows.
  const taken = (answeredAs: string) => ({
    ok: false as const,
    status: 409,
    error: portTakenError(name, entry.port, answeredAs),
  });
  const first = await probeWorkspace(name, entry.port);
  if (first.state === "other") return taken(first.answeredAs);
  if (first.state !== "stopped") return { ok: true, port: entry.port, started: false };

  spawnWorkspace(name, entry);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? LAUNCH_WAIT_MS;
  const pollMs = opts.pollMs ?? LAUNCH_POLL_MS;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const answer = await probeWorkspace(name, entry.port);
    if (answer.state === "other") return taken(answer.answeredAs);
    if (answer.state !== "stopped") return { ok: true, port: entry.port, started: true };
  }
  return {
    ok: false,
    status: 503,
    error: `workspace "${name}" did not come up on :${entry.port} within ${Math.round(waitMs / 1000)}s — start it with: bun run cli -- --workspace ${name} ui`,
  };
}
