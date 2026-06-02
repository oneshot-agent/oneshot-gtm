import { useEffect, useState } from "react";

/**
 * Per-row "generating draft" tracker persisted to localStorage, so leaving and
 * returning to /queue (or a full refresh) mid-generation preserves the spinner.
 * Mirrors `triggerRunState.ts`, but draft generation has no server "in-progress"
 * marker (the regenerate endpoint is synchronous, not fire-and-forget), so the
 * completion signal is the row's `lastDraftedAt`: once it advances past the
 * click time, the draft has landed and the marker clears.
 *
 * Storage: localStorage["oneshot-gtm:draft-generating:<id>"] = "<unix-ms>"
 */
const KEY_PREFIX = "oneshot-gtm:draft-generating:";
/**
 * Zombie cleanup. Drafting a single row (enrich + one LLM call, dry-run — no
 * deepResearch) runs ~5-90s. 5 min is generous headroom and also clears a
 * marker for a run that failed server-side (no draft written → `lastDraftedAt`
 * never advances, so the done-signal would never fire).
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
 *   done   = a draft was persisted AFTER the click AND it's been visible long
 *            enough (`lastDraftedAt > startedAt && visibleFor >= MIN_VISIBLE_MS`)
 *   zombie = `visibleFor > MAX_RUNTIME_MS` (covers a server-side failure that
 *            never wrote a draft)
 * An id is still "generating" unless done or zombie; done/zombie ids are
 * returned in `toClear` so the caller can drop their localStorage markers.
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
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick; // re-read localStorage + re-check expiry every tick

  const startedAtById = new Map<number, number>();
  for (const id of ids) {
    const startedAt = readStartedAt(id);
    if (startedAt != null) startedAtById.set(id, startedAt);
  }

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
