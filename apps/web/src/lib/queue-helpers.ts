import type { QueueRowView, QueueStatusView } from "@oneshot-gtm/shared-types";

export type QueueStatusFilter = QueueStatusView | "all";

/** Build the queue request without leaking UI-only `all`/null sentinel values. */
export function queueRequest(input: {
  statusFilter: QueueStatusFilter;
  playFilter: string;
  orderOverride: "ranked" | "newest" | null;
  limit?: number;
}): {
  status?: QueueStatusView;
  play?: string;
  order?: "ranked" | "newest";
  limit: number;
} {
  return {
    ...(input.statusFilter !== "all" ? { status: input.statusFilter } : {}),
    ...(input.playFilter !== "all" ? { play: input.playFilter } : {}),
    ...(input.orderOverride ? { order: input.orderOverride } : {}),
    limit: input.limit ?? 200,
  };
}

export function isQueueFilterActive(statusFilter: QueueStatusFilter, playFilter: string): boolean {
  return statusFilter !== "pending" || playFilter !== "all";
}

/** Visible plays plus plays with approved work elsewhere in the queue. */
export function queuePlayList(
  rows: ReadonlyArray<Pick<QueueRowView, "playName">>,
  approvedByPlay: Readonly<Record<string, number>>,
): string[] {
  return Array.from(
    new Set([...rows.map((row) => row.playName), ...Object.keys(approvedByPlay)]),
  ).toSorted();
}

export interface QueueSelectionState {
  count: number;
  someSelected: boolean;
  allSelected: boolean;
}

/** Keep selection semantics independent of React and stable across refetches. */
export function queueSelectionState(
  rows: ReadonlyArray<{ id: number }>,
  selected: ReadonlySet<number>,
): QueueSelectionState {
  return {
    count: selected.size,
    someSelected: selected.size > 0,
    // This deliberately mirrors the existing page behavior, including hidden selections.
    allSelected: rows.length > 0 && selected.size === rows.length,
  };
}

export function toggleQueueSelection(
  selected: ReadonlySet<number>,
  id: number,
): ReadonlySet<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectVisibleQueueRows(
  rows: ReadonlyArray<{ id: number }>,
  checked: boolean,
): ReadonlySet<number> {
  return checked ? new Set(rows.map((row) => row.id)) : new Set();
}

/** Bulk approval intentionally attempts every selected id; the API owns status/lock validation. */
export function bulkApprovalIds(selected: ReadonlySet<number>): number[] {
  return [...selected];
}

export interface DrainButtonState {
  playName: string | null;
  approvedCount: number;
  enabled: boolean;
  label: string;
}

export function drainButtonState(input: {
  playFilter: string;
  approvedByPlay: Readonly<Record<string, number>>;
  isRunnable: (playName: string) => boolean;
}): DrainButtonState {
  const { playFilter, approvedByPlay, isRunnable } = input;
  if (playFilter === "all") {
    return { playName: null, approvedCount: 0, enabled: false, label: "drain — pick a play above" };
  }
  const approvedCount = approvedByPlay[playFilter] ?? 0;
  if (!isRunnable(playFilter)) {
    return {
      playName: playFilter,
      approvedCount,
      enabled: false,
      label: `drain ${playFilter} · not runnable here`,
    };
  }
  if (approvedCount === 0) {
    return {
      playName: playFilter,
      approvedCount: 0,
      enabled: false,
      label: `drain ${playFilter} · nothing approved`,
    };
  }
  return {
    playName: playFilter,
    approvedCount,
    enabled: true,
    label: `drain ${playFilter} · ${approvedCount}`,
  };
}

export interface DrainSelectionState {
  playName: string | null;
  ids: number[];
  enabled: boolean;
  label: string;
}

export function drainSelectionState(input: {
  selected: ReadonlyArray<{ id: number; playName: string; status: string }>;
  isRunnable: (playName: string) => boolean;
}): DrainSelectionState {
  const approved = input.selected.filter((row) => row.status === "approved");
  if (approved.length === 0) {
    return { playName: null, ids: [], enabled: false, label: "drain selected · none approved" };
  }
  const plays = Array.from(new Set(approved.map((row) => row.playName)));
  if (plays.length > 1) {
    return {
      playName: null,
      ids: [],
      enabled: false,
      label: `drain selected · spans ${plays.length} plays`,
    };
  }
  const playName = plays[0] as string;
  const ids = approved.map((row) => row.id);
  if (!input.isRunnable(playName)) {
    return { playName, ids, enabled: false, label: "drain selected · not runnable here" };
  }
  return { playName, ids, enabled: true, label: `drain ${ids.length} selected` };
}

export type RowMeta = ReadonlyMap<number, { playName: string; status: string }>;

export function mergeRowMeta(
  prev: RowMeta,
  rows: ReadonlyArray<{ id: number; playName: string; status: string }>,
): RowMeta {
  let next: Map<number, { playName: string; status: string }> | null = null;
  for (const row of rows) {
    const current = prev.get(row.id);
    if (current && current.playName === row.playName && current.status === row.status) continue;
    next ??= new Map(prev);
    next.set(row.id, { playName: row.playName, status: row.status });
  }
  return next ?? prev;
}
