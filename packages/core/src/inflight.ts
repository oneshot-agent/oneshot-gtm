/**
 * Process-wide in-flight SEND tracker, used to drain gracefully on shutdown.
 *
 * The risk this guards: a `kill`/Ctrl-C lands between "OneShot accepted the
 * send" and "we wrote the local `sequence_events` row". The dedup keys off that
 * row, so a send lost in that gap can be re-sent (a duplicate) on retry. The
 * server's shutdown handler waits for `activeSendCount()` to reach 0 before
 * exiting, so every in-flight send finishes recording first.
 *
 * In-memory by design: it complements the PERSISTED `send_started_at` /
 * `sending_started_at` markers (which survive a hard kill and are reconciled by
 * the cold-boot sweep). This counter only exists within a live process and only
 * matters for the graceful (signal) path. A hard SIGKILL skips it — the boot
 * sweep is the backstop there.
 */

let active = 0;
let draining = false;

/** Mark a send as started. Pair with exactly one `endSend()`. Prefer `trackSend`. */
export function beginSend(): void {
  active++;
}

/** Mark a send as finished. Never drops below 0 even if mis-paired. */
export function endSend(): void {
  active = Math.max(0, active - 1);
}

/**
 * Wrap a send-and-persist span so it's counted as in-flight for its whole
 * duration — including the local record write that follows the SDK call. The
 * counter decrements even if `fn` throws.
 */
export async function trackSend<T>(fn: () => Promise<T>): Promise<T> {
  beginSend();
  try {
    return await fn();
  } finally {
    endSend();
  }
}

/** How many sends are currently in-flight. */
export function activeSendCount(): number {
  return active;
}

/** Flip the draining flag — send routes should start refusing new work (503). */
export function beginDraining(): void {
  draining = true;
}

/** True once shutdown has begun draining; new sends should be refused. */
export function isDraining(): boolean {
  return draining;
}

/** Test-only: reset module state between cases. */
export function __resetInflight(): void {
  active = 0;
  draining = false;
}

/**
 * Poll until no sends are in-flight or `timeoutMs` elapses. Resolves
 * immediately when already idle. On timeout, returns `{ drained: false }` with
 * the count still outstanding so the caller can log it and exit anyway (the
 * boot sweep reconciles whatever was left).
 */
export async function waitForSendsToDrain(opts: {
  timeoutMs: number;
  pollMs?: number;
}): Promise<{ drained: boolean; remaining: number }> {
  const poll = opts.pollMs ?? 200;
  const deadline = Date.now() + opts.timeoutMs;
  // `active` is mutated by concurrent endSend() calls during the await, not in
  // this body — read it through the accessor each tick.
  while (activeSendCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  const remaining = activeSendCount();
  return { drained: remaining === 0, remaining };
}
