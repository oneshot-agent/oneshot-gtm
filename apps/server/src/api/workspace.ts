import { fileURLToPath } from "node:url";
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
 * Workspace identity + roster for the dashboard shell. Each workspace is a
 * hermetic install on its own port, so "switching" means opening another
 * server's tab. `running` is probed HERE, server-side, so the web app stays
 * same-origin and the switcher has a single polling surface.
 */

/** The port this server is actually bound to (bin.ts reads the same env). */
function boundPort(): number {
  const p = Number.parseInt(process.env["PORT"] ?? "3030", 10);
  return Number.isFinite(p) ? p : 3030;
}

/** ~300ms liveness probe against another workspace's /api/health. */
export async function probe(port: number): Promise<boolean> {
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

/**
 * POST /api/workspace/launch {name} — start another workspace's dashboard
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

  if (await probe(entry.port)) {
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
  // A sibling workspace must resolve its own Smartlead account. Otherwise
  // applySecretsToEnv's fill-blanks rule keeps the parent's key and silently
  // lists/sends against the wrong account. --no-env-file also prevents Bun
  // from reintroducing the repository's Smartlead key before config loads.
  delete env["SMARTLEAD_API_KEY"];

  // fileURLToPath, not .pathname: a repo path with a space or non-ASCII char
  // would arrive percent-encoded and the child would die on a missing file.
  const binPath = fileURLToPath(new URL("../bin.ts", import.meta.url));
  spawnFn({ binPath, env });
}

/**
 * Another workspace by name — never this one, never an unregistered one.
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

/** How long a just-spawned workspace gets to answer /api/health before a move gives up. */
const LAUNCH_WAIT_MS = 15_000;
const LAUNCH_POLL_MS = 500;

/**
 * Resolve another workspace by name and make sure its server answers: probe,
 * spawn if needed, poll until healthy. The building block of a queue move —
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
  if (await probe(entry.port)) return { ok: true, port: entry.port, started: false };

  spawnWorkspace(name, entry);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? LAUNCH_WAIT_MS;
  const pollMs = opts.pollMs ?? LAUNCH_POLL_MS;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await probe(entry.port)) return { ok: true, port: entry.port, started: true };
  }
  return {
    ok: false,
    status: 503,
    error: `workspace "${name}" did not come up on :${entry.port} within ${Math.round(waitMs / 1000)}s — start it with: bun run cli -- --workspace ${name} ui`,
  };
}
