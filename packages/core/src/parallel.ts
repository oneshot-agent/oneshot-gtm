/**
 * Concurrency helpers shared by `find` and `plays`. `parallelMap` runs `fn`
 * over `items` with at most `concurrency` in flight, preserving input order;
 * errors propagate via Promise.all — catch per-item if partial success matters.
 */
/**
 * Bound a promise to `ms`. On deadline rejects with `<label> deadline
 * exceeded` while the underlying promise keeps running. Guards against
 * endpoints that hang instead of failing.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} deadline exceeded (${Math.round(ms / 1000)}s)`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

export async function parallelMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  /**
   * Optional per-completion hook, fired after each `fn(item, i)` resolves.
   * Fires in COMPLETION order across workers, not input order — key by
   * `index`. A throw inside the callback propagates as if `fn` threw.
   */
  onItem?: (item: T, result: R, index: number) => void,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  if (items.length === 0) return out;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i] as T;
      const result = await fn(item, i);
      out[i] = result;
      if (onItem) onItem(item, result, i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
