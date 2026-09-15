import type { WorkspaceInfo } from "@oneshot-gtm/shared-types";

/** A workspace a queue row can be moved to: every registered one but the current. */
export interface MoveTarget {
  name: string;
  port: number;
  running: boolean;
}

/**
 * The move menu's rows, from the roster the masthead switcher already polls.
 * Empty when the install has a single workspace, so the button never shows.
 */
export function moveTargets(info: WorkspaceInfo | undefined): MoveTarget[] {
  if (!info) return [];
  return info.workspaces
    .filter((w) => !w.isCurrent && w.name !== info.current.name)
    .map((w) => ({ name: w.name, port: w.port, running: w.running }));
}

/** Where the moved row can be reviewed: the destination's queue, pending filter. */
export function movedRowUrl(port: number): string {
  return `http://127.0.0.1:${port}/queue?status=pending`;
}
