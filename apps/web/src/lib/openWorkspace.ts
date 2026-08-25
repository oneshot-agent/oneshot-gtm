import { toast } from "sonner";
import { api } from "../api/client.ts";

/**
 * Open another workspace's dashboard, auto-starting its server when stopped.
 *
 * Shared by the sidebar switcher and the command palette so the two entry
 * points cannot drift (the palette originally fired the launch and never
 * opened the tab). MUST be called synchronously from a click/keyboard
 * handler: the tab is opened blank inside that user gesture and pointed at
 * the workspace once its health probe flips — a window.open after the
 * multi-second launch poll would be popup-blocked.
 */

const POLL_MS = 1_000;
const LAUNCH_TIMEOUT_MS = 15_000;

export interface WorkspaceRowLike {
  name: string;
  port: number;
  isCurrent: boolean;
  running: boolean;
}

export async function openWorkspace(
  row: WorkspaceRowLike,
  hooks: { onLaunchStart?: () => void; onSettled?: () => void } = {},
): Promise<void> {
  if (row.isCurrent) return;
  const url = `http://127.0.0.1:${row.port}/`;
  if (row.running) {
    window.open(url, "_blank");
    return;
  }

  const win = window.open("", "_blank");
  const startedAt = Date.now();
  hooks.onLaunchStart?.();
  try {
    const res = await api.workspaceLaunch(row.name);
    if (res.status === "already-running") {
      if (win) win.location.href = url;
      else window.open(url, "_blank");
      return;
    }
    // Explicit poll (plain requests, not react-query cache) until the
    // server-side probe reports the target running.
    while (Date.now() - startedAt < LAUNCH_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const info = await api.workspace();
      if (info.workspaces.find((w) => w.name === row.name)?.running) {
        if (win) win.location.href = url;
        toast.success(`workspace ${row.name} · up on :${row.port}`);
        return;
      }
    }
    win?.close();
    const cmd = `bun run cli -- --workspace ${row.name} ui`;
    toast.error(`workspace ${row.name} did not come up — start it manually`, {
      description: cmd,
      action: { label: "copy", onClick: () => void navigator.clipboard.writeText(cmd) },
      duration: 12_000,
    });
  } catch (err) {
    win?.close();
    toast.error(`launch failed: ${(err as Error).message}`);
  } finally {
    hooks.onSettled?.();
  }
}
