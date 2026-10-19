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

const owners = new Map<number, symbol>();

/**
 * Set a row's activity label for one operation. Pass the token back to
 * update or clear it; a token that no longer owns the row (a later operation
 * took over) changes nothing, so a stale cleanup never clears newer work.
 */
export function setRowActivity(id: number, label: string, token?: symbol): symbol {
  if (token && owners.get(id) !== token) return token;
  const owner = token ?? Symbol(id);
  owners.set(id, owner);
  activity.set(id, label);
  emit();
  return owner;
}

/** Clear the row's label, only if `token` is the operation that set it last. */
export function clearRowActivity(id: number, token: symbol): void {
  if (owners.get(id) !== token) return;
  owners.delete(id);
  activity.delete(id);
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
