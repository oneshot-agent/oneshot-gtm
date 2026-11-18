import { logEvent } from "@oneshot-gtm/core";

/**
 * The server answers every request on one event loop, and bun:sqlite is
 * synchronous: one slow query in a scheduler job holds every request behind
 * it. This notices such a stall after the fact and logs which scheduler step
 * was running when it began and when it ended, so the next slow query can be
 * found without a profiler.
 */
export interface LoopStall {
  stalledMs: number;
  stepBefore: string;
  stepAfter: string;
}

/**
 * A check to call every `intervalMs`. It reports a stall when a call arrives
 * more than `thresholdMs` later than due.
 */
export function loopLagChecker(opts: {
  intervalMs: number;
  thresholdMs: number;
  step: () => string;
  now?: () => number;
  report?: (stall: LoopStall) => void;
}): () => void {
  const now = opts.now ?? (() => performance.now());
  const report =
    opts.report ??
    ((stall: LoopStall) => logEvent("server.event_loop_stall", { ...stall }, "warn"));
  let last = now();
  let lastStep = opts.step();
  return () => {
    const at = now();
    const stalledMs = Math.round(at - last - opts.intervalMs);
    const step = opts.step();
    if (stalledMs > opts.thresholdMs) report({ stalledMs, stepBefore: lastStep, stepAfter: step });
    last = at;
    lastStep = step;
  };
}

/** Run the check every second; a stall over two seconds is logged. Returns the stop function. */
export function startLoopLagMonitor(step: () => string): () => void {
  const intervalMs = 1_000;
  const check = loopLagChecker({ intervalMs, thresholdMs: 2_000, step });
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
