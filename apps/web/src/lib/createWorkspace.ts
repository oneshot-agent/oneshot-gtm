import { toast } from "sonner";
import { api } from "../api/client.ts";

/**
 * The name input's `pattern`, matching the server's workspace name rule.
 * Browsers compile it with the `v` flag, where a literal `-` in a class must
 * be escaped; an invalid pattern is silently not enforced.
 */
export const WORKSPACE_NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{0,31}";

/** Called directly from form submission to reserve a tab before awaiting the server. */
export async function createAndOpenWorkspace(name: string): Promise<void> {
  const win = window.open("", "_blank");
  if (win) win.opener = null;
  try {
    const created = await api.workspaceCreate(name);
    if (created.warning) toast.warning(created.warning, { duration: Infinity });
    // Keep the host used to reach this dashboard (including a remote host or tunnel).
    const url = new URL(window.location.href);
    url.port = String(created.port);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      // The roster probes /api/health on the server, avoiding cross-origin browser fetches.
      const info = await api.workspace();
      if (info.workspaces.some((w) => w.name === created.name && w.running)) {
        if (win && !win.closed) win.location.href = url.href;
        else window.location.assign(url.href);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(
      `Workspace ${created.name} was created but is not answering yet. Start it from the workspace switcher.`,
    );
  } catch (err) {
    win?.close();
    throw err;
  }
}
