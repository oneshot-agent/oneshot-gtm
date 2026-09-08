import { useCallback, useMemo, useState } from "react";

type Primitive = string | number | boolean;

export interface SectionDraft<T extends Record<string, Primitive>> {
  /** What the inputs render: the server value overlaid with the draft. */
  values: T;
  /** Only the keys the founder touched (may equal the server value again). */
  draft: Partial<T>;
  set<K extends keyof T>(key: K, value: T[K]): void;
  /** Keys whose draft value differs from the server value right now. */
  dirtyKeys: (keyof T)[];
  dirty: boolean;
  /** The draft restricted to dirtyKeys — what a section save posts. */
  snapshot: Partial<T>;
  /**
   * After a successful save + refetch: forget the keys whose CURRENT draft
   * value still equals what was sent. A keystroke that landed during the
   * in-flight save differs from `sent` and therefore survives.
   */
  commit(sent: Partial<T>): void;
  reset(): void;
}

/**
 * Draft overlay for one settings section (issue #451).
 *
 * Nothing is ever copied from the server into local state. Inputs read
 * `draft[k]` when the founder has touched `k`, else `server[k]`, so a
 * background `["setup"]` refetch can only ever change untouched keys — the
 * old hydrate-into-useState pattern silently reverted unsaved edits on every
 * refetch unless a field had its own hand-rolled dirty ref.
 *
 * `server` must be a normalized projection (nulls → "", numbers → text for
 * text inputs) so every value is a comparable primitive.
 */
export function useSectionDraft<T extends Record<string, Primitive>>(
  server: T,
  initialDraft?: Partial<T>,
): SectionDraft<T> {
  const [draft, setDraft] = useState<Partial<T>>(() => initialDraft ?? {});

  const values = useMemo(() => ({ ...server, ...draft }) as T, [server, draft]);

  const dirtyKeys = useMemo(
    () => (Object.keys(draft) as (keyof T)[]).filter((k) => draft[k] !== server[k]),
    [draft, server],
  );

  const snapshot = useMemo(() => {
    const out: Partial<T> = {};
    for (const k of dirtyKeys) out[k] = draft[k];
    return out;
  }, [dirtyKeys, draft]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const commit = useCallback((sent: Partial<T>) => {
    setDraft((d) => {
      const next: Partial<T> = { ...d };
      for (const k of Object.keys(sent) as (keyof T)[]) {
        if (Object.hasOwn(next, k) && next[k] === sent[k]) delete next[k];
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => setDraft({}), []);

  return { values, draft, set, dirtyKeys, dirty: dirtyKeys.length > 0, snapshot, commit, reset };
}
