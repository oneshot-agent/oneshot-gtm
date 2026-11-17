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

/** The part of `window.location` a workspace link is built from. */
export type PageLocation = Pick<Location, "protocol" | "hostname">;

/**
 * Another workspace's dashboard: its own port, on the protocol and hostname
 * this page was opened with. On the host machine that is loopback; for a
 * member it is the allowed host they browse to, where loopback would be their
 * own machine.
 */
export function workspaceUrl(
  port: number,
  path = "/",
  page: PageLocation = window.location,
): string {
  return `${page.protocol}//${page.hostname}:${port}${path}`;
}

/** Where the moved row can be reviewed: the destination's queue, pending filter. */
export function movedRowUrl(port: number, page?: PageLocation): string {
  return workspaceUrl(port, "/queue?status=pending", page);
}
