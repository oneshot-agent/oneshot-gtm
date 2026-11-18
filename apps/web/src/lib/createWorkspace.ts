import { toast } from "sonner";
import { api } from "../api/client.ts";

/**
 * The name input's `pattern`, matching the server's workspace name rule.
 * Browsers compile it with the `v` flag, where a literal `-` in a class must
 * be escaped; an invalid pattern is silently not enforced.
 */
export const WORKSPACE_NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{0,31}";

/**
 * How long a new workspace's server gets to answer. The same window the
 * server gives a launch (LAUNCH_WAIT_MS in apps/server/src/api/workspace.ts).
 */
const STARTUP_WAIT_MS = 150_000;
const POLL_MS = 1_000;

/** True on the host machine itself; false for a member on an allowed host. */
export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".localhost");
}

/** What the host operator runs so members can reach `port` (docs/members.md). */
export function servePortCommand(port: number): string {
  return `tailscale serve --bg --https=${port} http://127.0.0.1:${port}`;
}

/**
 * A created workspace a member cannot open yet: dashboards listen on loopback,
 * and the host serves each port to members separately.
 */
export interface RemoteWorkspaceSetup {
  name: string;
  port: number;
  /** Where the workspace opens once the host serves `port`. */
  url: string;
  /**
   * Its own server answered on `port`. False: created, but not confirmed up.
   * Null: created, and the check is still running.
   */
  running: boolean | null;
}

/**
 * Create a workspace and wait until its own server answers on its port. On the
 * host machine the new dashboard then opens; call this directly from form
 * submission, because the tab is reserved before the server is awaited. On any
 * other address nothing opens: the setup step goes to `onRemoteSetup` as soon
 * as the workspace exists, and is returned once the server was seen answering
 * or the check gave up.
 */
export async function createAndOpenWorkspace(
  name: string,
  onRemoteSetup?: (setup: RemoteWorkspaceSetup) => void,
): Promise<RemoteWorkspaceSetup | null> {
  // Keep the host used to reach this dashboard (including a remote host or tunnel).
  const url = new URL(window.location.href);
  const remote = !isLoopbackHost(url.hostname);
  const win = remote ? null : window.open("", "_blank");
  if (win) win.opener = null;
  // Ends the wait, including a roster request that never answers.
  const expired = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const created = await api.workspaceCreate(name);
    timer = setTimeout(() => expired.abort(), STARTUP_WAIT_MS);
    if (created.warning) toast.warning(created.warning, { duration: Infinity });
    url.port = String(created.port);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    const answers = async (): Promise<boolean> => {
      while (!expired.signal.aborted) {
        // The roster probes /api/health on the server, avoiding cross-origin browser fetches.
        const info = await api.workspaceWithin(expired.signal).catch((err: unknown) => {
          if (expired.signal.aborted) return null;
          throw err;
        });
        // `verified`: the server on the assigned port said it is this workspace.
        // A name match alone could be another dashboard that holds the port.
        const up = info?.workspaces.some(
          (w) => w.name === created.name && w.port === created.port && w.verified,
        );
        if (up) return true;
        if (!expired.signal.aborted) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return false;
    };
    if (remote) {
      // The workspace exists now and cannot be created again, so the member
      // gets its port and serve step before the check, whatever it finds.
      const setup = { name: created.name, port: created.port, url: url.href };
      onRemoteSetup?.({ ...setup, running: null });
      return { ...setup, running: await answers().catch(() => false) };
    }
    if (!(await answers())) {
      throw new Error(
        `Workspace ${created.name} was created but is not answering yet. Start it from the workspace switcher.`,
      );
    }
    if (win && !win.closed) win.location.href = url.href;
    else window.location.assign(url.href);
    return null;
  } catch (err) {
    win?.close();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
