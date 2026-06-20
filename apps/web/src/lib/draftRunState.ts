import { useEffect, useState } from "react";

/**
 * Per-row "generating draft" flag in localStorage so returning to /queue mid-
 * generation keeps the spinner. No server "in-progress" marker (regenerate is
 * synchronous), so completion = the row's `lastDraftedAt` advancing past the
 * click time. Key: localStorage["oneshot-gtm:draft-generating:<id>"] = "<ms>".
 */
const KEY_PREFIX = "oneshot-gtm:draft-generating:";
/**
 * Zombie cleanup. A single dry-run draft (enrich + one LLM call) runs ~5-90s;
 * 5 min is headroom and also clears the marker when a run fails server-side
 * (no draft written → `lastDraftedAt` never advances → done-signal never fires).
 */
const MAX_RUNTIME_MS = 5 * 60 * 1000;
/**
 * Floor so a cached-enrich + fast LLM draft (sub-second) still flashes a
 * spinner instead of the button flickering straight back to "regenerate".
 */
const MIN_VISIBLE_MS = 800;

export function markDraftGenerating(id: number): void {
  try {
    localStorage.setItem(KEY_PREFIX + id, String(Date.now()));
  } catch {
    // private mode / SSR — no-op
  }
}

export function clearDraftGenerating(id: number): void {
  try {
    localStorage.removeItem(KEY_PREFIX + id);
  } catch {
    // ignore
  }
}

function readStartedAt(id: number): number | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Pure reconciliation (unit-tested). For each id with a stored `startedAt`:
 * done = `lastDraftedAt > startedAt && visibleFor >= MIN_VISIBLE_MS`; zombie =
 * `visibleFor > MAX_RUNTIME_MS` (server-side failure that never wrote a draft).
 * Done/zombie ids come back in `toClear` so the caller drops their markers.
 */
export function reconcileGenerating(opts: {
  startedAtById: Map<number, number>;
  lastDraftedAtById: Map<number, number | null>;
  now: number;
}): { generating: Set<number>; toClear: number[] } {
  const generating = new Set<number>();
  const toClear: number[] = [];
  for (const [id, startedAt] of opts.startedAtById) {
    const visibleFor = opts.now - startedAt;
    const lastDraftedAt = opts.lastDraftedAtById.get(id) ?? null;
    const done = lastDraftedAt != null && lastDraftedAt > startedAt && visibleFor >= MIN_VISIBLE_MS;
    const zombie = visibleFor > MAX_RUNTIME_MS;
    if (done || zombie) {
      toClear.push(id);
    } else {
      generating.add(id);
    }
  }
  return { generating, toClear };
}

/**
 * Returns the set of row ids currently showing a generate-draft spinner,
 * reconstructed from localStorage so it survives navigation + refresh. Ticks
 * every 1s to catch a freshly-set marker and to expire done/zombie markers as
 * the queue refetch advances `lastDraftedAt`.
 */
export function useGeneratingDrafts(
  ids: number[],
  lastDraftedAtById: Map<number, string | null>,
): Set<number> {
  const [tick, setTick] = useState(0);

  const startedAtById = new Map<number, number>();
  for (const id of ids) {
    const startedAt = readStartedAt(id);
    if (startedAt != null) startedAtById.set(id, startedAt);
  }

  // Only tick while at least one draft is generating — otherwise the queue page
  // re-renders every second for nothing. On remount with an active marker the
  // first render sets this true and starts the interval; it stops once all
  // markers clear (draft landed / zombie-expired).
  const anyGenerating = startedAtById.size > 0;
  useEffect(() => {
    if (!anyGenerating) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyGenerating]);
  void tick; // re-read localStorage + re-check expiry every tick

  const lastDraftedMs = new Map<number, number | null>();
  for (const id of ids) {
    const iso = lastDraftedAtById.get(id) ?? null;
    lastDraftedMs.set(id, iso ? new Date(iso).getTime() : null);
  }

  const { generating, toClear } = reconcileGenerating({
    startedAtById,
    lastDraftedAtById: lastDraftedMs,
    now: Date.now(),
  });
  for (const id of toClear) clearDraftGenerating(id);
  return generating;
}
