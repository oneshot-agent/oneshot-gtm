import type { LearningKind, QueueStatusView } from "@oneshot-gtm/shared-types";
import type { QueueStatusFilter } from "./queue-helpers.ts";
import { isLearningKind } from "./learning.ts";

/**
 * /queue filters live in the URL (`?status=&play=&order=`) so back/forward and
 * reload keep them, and the last set is remembered in localStorage so a bare
 * `/queue` link (sidebar, `q`, palette) lands where the founder left off. Each
 * workspace is its own origin, so each keeps its own filters.
 */
export interface QueueSearch {
  status?: QueueStatusFilter;
  play?: string;
  order?: "ranked" | "newest";
  /** Deep link into the learning review card (#813): one kind, optionally one prospect. Never remembered. */
  learning?: LearningKind;
  prospectId?: number;
}

const STATUS_VALUES: ReadonlySet<string> = new Set<QueueStatusView | "all">([
  "all",
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
]);

export function validateQueueSearch(search: Record<string, unknown>): QueueSearch {
  const out: QueueSearch = {};
  const status = search["status"];
  if (typeof status === "string" && STATUS_VALUES.has(status)) {
    out.status = status as QueueStatusFilter;
  }
  const play = search["play"];
  if (typeof play === "string" && play.length > 0) out.play = play;
  const order = search["order"];
  if (order === "ranked" || order === "newest") out.order = order;
  const learning = search["learning"];
  if (isLearningKind(learning)) out.learning = learning;
  const prospectId = Number(search["prospectId"]);
  if (Number.isInteger(prospectId) && prospectId > 0) out.prospectId = prospectId;
  return out;
}

export function hasQueueFilters(search: QueueSearch): boolean {
  return search.status != null || search.play != null || search.order != null;
}

const STORAGE_KEY = "oneshot-gtm:queue-filters";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadQueueFilters(storage: StorageLike | null = defaultStorage()): QueueSearch {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return validateQueueSearch(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function saveQueueFilters(
  filters: QueueSearch,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    const { learning: _learning, prospectId: _prospectId, ...remembered } = filters;
    storage?.setItem(STORAGE_KEY, JSON.stringify(validateQueueSearch({ ...remembered })));
  } catch {
    // private mode / quota: filters just won't be remembered
  }
}

const SCROLL_KEY = "oneshot-gtm:queue-scroll";

/** Scroll offset of the queue's `<main>`, kept per tab (sessionStorage). */
export function loadQueueScroll(): { top: number; filters: string } | null {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { top?: unknown; filters?: unknown };
    if (typeof parsed.top !== "number" || typeof parsed.filters !== "string") return null;
    return { top: parsed.top, filters: parsed.filters };
  } catch {
    return null;
  }
}

export function saveQueueScroll(top: number, filters: string): void {
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ top, filters }));
  } catch {
    // ignore
  }
}

/** Stable identity of a filter set, so a scroll offset is only restored onto the view it came from. */
export function queueFiltersKey(filters: QueueSearch): string {
  return JSON.stringify([filters.status ?? "", filters.play ?? "", filters.order ?? ""]);
}
