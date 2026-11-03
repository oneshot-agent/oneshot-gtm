import {
  queueRowMatchesShow,
  type QueueListResponse,
  type QueueOrder,
  type QueueRowView,
  type QueueShow,
  type QueueStatusView,
} from "@oneshot-gtm/shared-types";

/**
 * A /queue status chip. `no-offer` is not a status: it is the pending rows
 * whose offer writer found no strong offer, which the `pending` review list
 * leaves out.
 */
export type QueueStatusFilter = QueueStatusView | "all" | "no-offer";

/** /queue's Channel filter: the channels a first touch is sent on from the queue. */
export type QueueChannelFilter = "email" | "linkedin";

/** Rows per page of the /queue table; "show more" reads the next page at `offset`. */
export const QUEUE_PAGE_SIZE = 50;

/** Build the queue request without leaking UI-only `all`/null sentinel values. */
export function queueRequest(input: {
  statusFilter: QueueStatusFilter;
  playFilter: string;
  orderOverride: QueueOrder | null;
  show?: QueueShow | null;
  channel?: QueueChannelFilter | null;
  limit?: number;
  offset?: number;
}): {
  status?: QueueStatusView;
  offerSkip?: "only" | "exclude";
  play?: string;
  order?: QueueOrder;
  show?: QueueShow;
  channel?: QueueChannelFilter;
  limit: number;
  offset?: number;
} {
  const { statusFilter } = input;
  const status =
    statusFilter === "all"
      ? {}
      : statusFilter === "no-offer"
        ? { status: "pending" as const, offerSkip: "only" as const }
        : statusFilter === "pending"
          ? { status: "pending" as const, offerSkip: "exclude" as const }
          : { status: statusFilter };
  return {
    ...status,
    ...(input.playFilter !== "all" ? { play: input.playFilter } : {}),
    ...(input.orderOverride ? { order: input.orderOverride } : {}),
    ...(input.show ? { show: input.show } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    limit: input.limit ?? 200,
    ...(input.offset ? { offset: input.offset } : {}),
  };
}

/**
 * Rows of one captured /queue document in demo mode: each status/order/play
 * view is captured once at this limit (the server's cap), and every page,
 * Show and Channel filter of it is cut from that document (`demoQueuePage`).
 */
export const DEMO_QUEUE_LIMIT = 500;

/**
 * A /queue page cut from a captured document, as the server would cut it:
 * the Show and Channel filters (the chips' own predicate,
 * `queueRowMatchesShow`), then `offset` and `limit`. Captured views carry no
 * "never drafted" bit, so No draft reads a row with no usable draft. Ranked
 * order filters the captured ranking rather than ranking the filtered rows.
 */
export function demoQueuePage(
  doc: QueueListResponse,
  opts: { show?: QueueShow; channel?: QueueChannelFilter; offset?: number; limit?: number },
): QueueListResponse {
  const { show, channel } = opts;
  const filtered = show != null || channel != null;
  const rows = filtered
    ? doc.rows.filter(
        (row) => (!show || queueRowMatchesShow(show, row)) && (!channel || row.channel === channel),
      )
    : doc.rows;
  const offset = Math.max(0, opts.offset ?? 0);
  const out: QueueListResponse = {
    ...doc,
    rows: rows.slice(offset, offset + (opts.limit ?? rows.length)),
  };
  delete out.total;
  delete out.totalIsLowerBound;
  // A capture that hit its limit left rows out: a count over it is a floor.
  const cut = doc.total != null && doc.total > doc.rows.length;
  const total = filtered ? rows.length : (doc.total ?? rows.length);
  out.total = total;
  if ((filtered && cut) || doc.totalIsLowerBound) out.totalIsLowerBound = true;
  return out;
}

/** The Show filter's choices, in the order the control lists them. */
export const QUEUE_SHOW_LABELS: Record<QueueShow, string> = {
  "offer-ready": "Offer ready",
  "has-draft": "Has draft",
  ready: "Ready to send",
  held: "Held",
  "no-draft": "No draft",
};

/** "50 of 312 shown", "312 shown", "50 of 2,000+ shown": the page against the filtered total. */
export function queueCountLine(input: {
  shown: number;
  total: number | undefined;
  lowerBound?: boolean;
  format: (n: number) => string;
}): string {
  const { shown, total, format } = input;
  if (total == null || (total <= shown && !input.lowerBound)) return `${format(shown)} shown`;
  return `${format(shown)} of ${format(total)}${input.lowerBound ? "+" : ""} shown`;
}

/**
 * What "Approve pending" and "Batch send…" act on while a Show or Channel
 * filter is on: the filtered rows, which are the page's own only on the tab
 * they act on (Pending for approve, Approved for batch send). On another tab
 * the count is unknown, so the action waits for that tab.
 */
export function filteredBulkState(input: {
  filtered: boolean;
  statusFilter: QueueStatusFilter;
  acts: "pending" | "approved";
  total: number | undefined;
  lowerBound?: boolean;
  format?: (n: number) => string;
}): { count: number | null; label: string | null; blocked: string | null } {
  if (!input.filtered) return { count: null, label: null, blocked: null };
  if (input.statusFilter !== input.acts) {
    return {
      count: null,
      label: null,
      blocked: `open ${input.acts === "pending" ? "Pending" : "Approved"} to act on the filtered rows`,
    };
  }
  const count = input.total ?? 0;
  const format = input.format ?? String;
  return { count, label: `${format(count)}${input.lowerBound ? "+" : ""}`, blocked: null };
}

/**
 * Pending rows split the way /queue shows them: `review` is the pending list
 * (rows with no strong offer left out), `noOffer` is those rows.
 */
export function pendingSplit(
  data: Pick<QueueListResponse, "counts" | "noStrongOffer"> | undefined,
): { review: number; noOffer: number } {
  const pending = data?.counts.pending ?? 0;
  const noOffer = Math.min(pending, Math.max(0, data?.noStrongOffer ?? 0));
  return { review: pending - noOffer, noOffer };
}

export function isQueueFilterActive(statusFilter: QueueStatusFilter, playFilter: string): boolean {
  return statusFilter !== "pending" || playFilter !== "all";
}

/**
 * Every play with rows under the current status (`playCounts`), plus the
 * visible plays (an older server sends no counts) and plays with approved
 * work elsewhere in the queue.
 */
export function queuePlayList(
  rows: ReadonlyArray<Pick<QueueRowView, "playName">>,
  approvedByPlay: Readonly<Record<string, number>>,
  playCounts: Readonly<Record<string, number>> = {},
): string[] {
  return Array.from(
    new Set([
      ...Object.keys(playCounts),
      ...rows.map((row) => row.playName),
      ...Object.keys(approvedByPlay),
    ]),
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
    label: `batch send ${playFilter} · ${approvedCount} approved, choose how many next`,
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
