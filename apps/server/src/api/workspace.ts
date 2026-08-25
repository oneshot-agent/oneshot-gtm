import {
  WorkspaceError,
  currentWorkspaceName,
  listWorkspaces,
  loadRegistry,
} from "@oneshot-gtm/core";
import { configDir } from "@oneshot-gtm/core";
import type { WorkspaceInfo } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * Workspace identity + roster for the dashboard shell.
 *
 * Each workspace is a hermetic install serving its own dashboard on its own
 * port, so "switching" in the UI means opening ANOTHER server's tab — which is
 * only possible if the browser can learn (a) which workspace this server is,
 * and (b) which others exist and whether they are up. Until this route, the
 * browser's entire workspace knowledge was a string-split of the doctor
 * check's message.
 *
 * `running` is probed HERE, server-side, so the web app stays same-origin
 * (client.ts BASE = "/api") and the switcher has a single polling surface.
 */

/** The port this server is actually bound to (bin.ts reads the same env). */
function boundPort(): number {
  const p = Number.parseInt(process.env["PORT"] ?? "3030", 10);
  return Number.isFinite(p) ? p : 3030;
}

/** ~300ms liveness probe against another workspace's /api/health. */
async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(300),
    });
    return res.ok;
  } catch {
    return false;
  }
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
        return {
          name: wsName,
          home: entry.home,
          port: isCurrent ? current.port : entry.port,
          isCurrent,
          isDefault: wsName === reg.default,
          running: isCurrent ? true : await probe(entry.port),
        };
      }),
    );
    // A server started with a bare ONESHOT_GTM_HOME (unregistered) won't match
    // any roster row — surface it so the badge never lies about identity.
    if (!roster.some((w) => w.isCurrent)) {
      roster.unshift({ ...current, isCurrent: true, isDefault: false, running: true });
    }
  } catch (err) {
    if (!(err instanceof WorkspaceError)) throw err;
    // Corrupt registry: degrade to self-only rather than a 500 — the badge
    // (identity) matters more than the switcher (roster).
    roster = [{ ...current, isCurrent: true, isDefault: name === "default", running: true }];
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
  const proc = Bun.spawn([process.execPath, "run", binPath], {
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

/**
 * POST /api/workspace/launch {name} — start another workspace's dashboard
 * server in the background, so the switcher's click can open it.
 *
 * Deliberately unsupervised: no PID file, no lifecycle management. The spawned
 * server runs until killed manually or the machine restarts — an accepted
 * trade-off for one-click switching on a single-user local tool. The roster's
 * `running` probe is the source of truth for what is actually up.
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

  if (await probe(entry.port)) {
    return jsonResponse({ status: "already-running", port: entry.port }, 200, req);
  }

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

  const binPath = new URL("../bin.ts", import.meta.url).pathname;
  spawnFn({ binPath, env });

  return jsonResponse({ status: "starting", port: entry.port }, 200, req);
}
