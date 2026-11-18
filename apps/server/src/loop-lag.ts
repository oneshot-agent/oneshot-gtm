import { logEvent } from "@oneshot-gtm/core";

/**
 * The server answers every request on one event loop, and bun:sqlite is
 * synchronous: one slow query in a scheduler job holds every request behind
 * it. This notices such a stall after the fact and logs which scheduler step
 * held the loop longest, so the next slow query can be found without a
 * profiler.
 */
export interface LoopStall {
  stalledMs: number;
  /** The step that ran longest since the previous check, and for how long. */
  longestStep: string;
  longestStepMs: number;
  /** Every step entered since the previous check, in order, the running one first. */
  steps: string[];
}

export interface LoopLagChecker {
  /** Call every `intervalMs`. Reports a stall when a call arrives more than `thresholdMs` late. */
  check(): void;
  /** Mark the step now running. Every change is kept until the next check. */
  step(name: string): void;
}

export function loopLagChecker(opts: {
  intervalMs: number;
  thresholdMs: number;
  now?: () => number;
  report?: (stall: LoopStall) => void;
}): LoopLagChecker {
  const now = opts.now ?? (() => performance.now());
  const report =
    opts.report ??
    ((stall: LoopStall) => logEvent("server.event_loop_stall", { ...stall }, "warn"));
  // The step running at the last check, and when that check ran.
  let running = "idle";
  let last = now();
  // Steps entered since the last check. A synchronous step sets its label and
  // the next one replaces it before any check can run, so only these
  // timestamps say which of them held the loop.
  let marks: Array<{ name: string; at: number }> = [];
  return {
    step(name) {
      marks.push({ name, at: now() });
    },
    check() {
      const at = now();
      const stalledMs = Math.round(at - last - opts.intervalMs);
      const spans = [{ name: running, at: last }, ...marks];
      if (stalledMs > opts.thresholdMs) {
        let longest = { name: running, ms: -1 };
        spans.forEach((s, i) => {
          const ms = (spans[i + 1]?.at ?? at) - s.at;
          if (ms > longest.ms) longest = { name: s.name, ms };
        });
        report({
          stalledMs,
          longestStep: longest.name,
          longestStepMs: Math.round(longest.ms),
          steps: spans.map((s) => s.name),
        });
      }
      running = spans[spans.length - 1]!.name;
      last = at;
      marks = [];
    },
  };
}

/** Run the check every second; a stall over two seconds is logged. */
export function startLoopLagMonitor(): { step(name: string): void; stop(): void } {
  const intervalMs = 1_000;
  const lag = loopLagChecker({ intervalMs, thresholdMs: 2_000 });
  const timer = setInterval(() => lag.check(), intervalMs);
  timer.unref?.();
  return { step: (name) => lag.step(name), stop: () => clearInterval(timer) };
}
