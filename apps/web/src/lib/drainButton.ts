/**
 * State of /queue's single drain button, derived from the PLAY filter chips
 * above it. One button instead of one-per-play: the play is already chosen by
 * the filter, and a disabled button should say *why* it's disabled rather than
 * just dimming out.
 *
 *   { playFilter: "all" }                        → "drain — pick a play above"
 *   { playFilter: "luma-events", approved: 145 } → "drain luma-events · 145"
 *   { playFilter: "show-hn", approved: 0 }       → "drain show-hn · nothing approved"
 *   { playFilter: "concierge" } (not runnable)   → "drain concierge · not runnable here"
 */
export interface DrainButtonState {
  /** Play to drain, or null when the button can't act. */
  playName: string | null;
  approvedCount: number;
  enabled: boolean;
  label: string;
}

export function drainButtonState(input: {
  playFilter: string;
  approvedByPlay: Record<string, number>;
  /** Usually `isRunnablePlay` from shared-types; injected so this stays pure. */
  isRunnable: (playName: string) => boolean;
}): DrainButtonState {
  const { playFilter, approvedByPlay, isRunnable } = input;
  if (playFilter === "all") {
    return { playName: null, approvedCount: 0, enabled: false, label: "drain — pick a play above" };
  }
  const approvedCount = approvedByPlay[playFilter] ?? 0;
  // Runnability first: "not runnable here" is the more useful complaint even
  // when the play also happens to have nothing approved.
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

/**
 * State of the selection bar's "drain selected" button.
 *
 * Draining runs through /run, which is per-play and only accepts approved
 * rows — so a selection that spans two plays, or holds nothing approved, can't
 * be drained as one batch. Rather than silently draining a subset, the button
 * disables and names the reason.
 *
 *   3 approved luma-events rows          → "drain 3 selected"
 *   2 luma-events + 1 repo-interest      → "drain selected · spans 2 plays"
 *   3 pending rows                       → "drain selected · none approved"
 */
export interface DrainSelectionState {
  playName: string | null;
  /** Row ids that would actually be drained (approved, single play). */
  ids: number[];
  enabled: boolean;
  label: string;
}

export function drainSelectionState(input: {
  /** The selected rows, as loaded in the table. */
  selected: Array<{ id: number; playName: string; status: string }>;
  isRunnable: (playName: string) => boolean;
}): DrainSelectionState {
  const approved = input.selected.filter((r) => r.status === "approved");
  if (approved.length === 0) {
    return { playName: null, ids: [], enabled: false, label: "drain selected · none approved" };
  }
  const plays = Array.from(new Set(approved.map((r) => r.playName)));
  if (plays.length > 1) {
    return {
      playName: null,
      ids: [],
      enabled: false,
      label: `drain selected · spans ${plays.length} plays`,
    };
  }
  const playName = plays[0] as string;
  const ids = approved.map((r) => r.id);
  if (!input.isRunnable(playName)) {
    return { playName, ids, enabled: false, label: "drain selected · not runnable here" };
  }
  return { playName, ids, enabled: true, label: `drain ${ids.length} selected` };
}

/**
 * Fold the currently-visible rows into the session's id → {play, status} map.
 *
 * /queue's selection is a Set of row ids that survives filter changes, but
 * `rows` only ever holds the current filtered page. Without this memory, a
 * selection spanning two plays looks single-play the moment you filter to one
 * of them — and "drain selected" would quietly act on the visible subset.
 *
 * Returns the previous map unchanged when nothing moved, so it's safe to call
 * from an effect keyed on `rows`.
 */
export type RowMeta = ReadonlyMap<number, { playName: string; status: string }>;

export function mergeRowMeta(
  prev: RowMeta,
  rows: ReadonlyArray<{ id: number; playName: string; status: string }>,
): RowMeta {
  let next: Map<number, { playName: string; status: string }> | null = null;
  for (const r of rows) {
    const cur = prev.get(r.id);
    if (cur && cur.playName === r.playName && cur.status === r.status) continue;
    next ??= new Map(prev);
    next.set(r.id, { playName: r.playName, status: r.status });
  }
  return next ?? prev;
}
