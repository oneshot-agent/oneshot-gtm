/**
 * A predecessor may hold the ledger write lock beyond SQLite's busy timeout.
 * Retry each cold-boot cleanup for about a minute, including time spent in
 * SQLite. The last attempt can exceed the budget by one busy timeout. Keep
 * this awaited before binding HTTP or starting the scheduler: neither may
 * claim a trigger while its old running marker is still being recovered.
 * The caller logs only the final failure and allows startup to continue.
 */
export async function retryBootCleanup<T>(cleanup: () => T): Promise<T> {
  const deadline = Date.now() + 60_000;
  let delayMs = 1_000;
  for (;;) {
    try {
      return cleanup();
    } catch (err) {
      const error = err as { code?: string; message?: string } | null;
      const busy =
        error?.code === "SQLITE_BUSY" || /database is locked/i.test(error?.message ?? "");
      const remainingMs = deadline - Date.now();
      if (!busy || remainingMs <= 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
}
