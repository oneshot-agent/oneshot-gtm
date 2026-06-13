/**
 * Run `fn` over `items` with at most `concurrency` Promises in flight at once.
 * Preserves input order in the result array. Errors propagate via Promise.all
 * — caller is expected to catch per-item internally if partial success matters.
 *
 * Worker-pool implementation: spawn `concurrency` workers that pull from a
 * shared cursor. Cheaper than a chunked Promise.all (which stalls on the
 * slowest item per chunk) and avoids the dependency surface of p-limit.
 *
 * Lives in core so both `find` (candidate pipelines) and `plays` (batch send
 * loops) can share it without a cross-package dependency.
 */
/**
 * Bound a promise to `ms`. On deadline: rejects with `<label> deadline
 * exceeded` — the underlying promise keeps running (callers that care attach
 * their own late-settle handlers; an abandoned SDK job is harmless). Guards
 * against platform endpoints that hang instead of failing (observed on both
 * the inbox and enrichment tools 2026-06).
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
   * Optional per-completion hook. Fires once per item AFTER `fn(item, i)`
   * resolves, with the (item, result, index). Used by /api/run's SSE handler
   * to emit `draft` + `send` frames as each target finishes — instead of
   * batching them all at the end when the whole `Promise.all` resolves.
   *
   * Order: callbacks fire in COMPLETION order across workers, not input
   * order. Consumers that care about index (the SSE event already does)
   * key by the `index` argument.
   *
   * Throws inside the callback propagate as if `fn` threw — keep handlers
   * defensive.
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
