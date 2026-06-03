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
export async function parallelMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  if (items.length === 0) return out;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
