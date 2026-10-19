import { useSyncExternalStore } from "react";

/**
 * What a queue row is busy doing right now, in words ("Writing 5 offers…",
 * "Rewriting the draft…"). Shared on the page so the offer block and the
 * letter show the same work, whichever started it. In memory only: the
 * localStorage draft marker (draftRunState.ts) is what survives navigation.
 */
const activity = new Map<number, string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Set (or, with null, clear) a row's activity label. */
export function setRowActivity(id: number, label: string | null): void {
  if (label) activity.set(id, label);
  else activity.delete(id);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The row's current activity label, or null when it is idle. */
export function useRowActivity(id: number): string | null {
  return useSyncExternalStore(
    subscribe,
    () => activity.get(id) ?? null,
    () => null,
  );
}

/** Test seam: the label without React. */
export function rowActivityOf(id: number): string | null {
  return activity.get(id) ?? null;
}
