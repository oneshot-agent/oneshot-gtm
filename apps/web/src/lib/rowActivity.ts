import { useSyncExternalStore } from "react";

/**
 * What a queue row is busy doing right now, in words ("Writing 5 offers…",
 * "Rewriting the draft…"). Shared on the page so the offer block and the
 * letter show the same work, whichever started it. In memory only: the
 * localStorage draft marker (draftRunState.ts) is what survives navigation.
 */
const activity = new Map<number, string>();
const listeners = new Set<() => void>();
/** Bumped on every change: the snapshot a page reading many rows subscribes to. */
let version = 0;

function emit(): void {
  version++;
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
  const read = (): string | null => activity.get(id) ?? null;
  // The dashboard never renders on a server; a static render reads the same store.
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Re-renders on any row's change, for a page that reads many rows' labels
 * in one render (`rowActivityOf`) instead of one hook per row.
 */
export function useRowActivityChanges(): number {
  const read = (): number => version;
  return useSyncExternalStore(subscribe, read, read);
}

/** The label without React: a test, or a render subscribed by `useRowActivityChanges`. */
export function rowActivityOf(id: number): string | null {
  return activity.get(id) ?? null;
}
