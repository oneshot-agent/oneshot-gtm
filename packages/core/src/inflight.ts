/**
 * Process-wide in-flight SEND tracker for graceful shutdown. A kill landing
 * between "OneShot accepted the send" and "sequence_events row written" would
 * dedup as unsent and re-send a duplicate — so shutdown waits for
 * activeSendCount() to hit 0. In-memory by design: the persisted send markers
 * + cold-boot sweep are the backstop for a hard SIGKILL.
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
 * Poll until no sends are in-flight or `timeoutMs` elapses. On timeout returns
 * `{ drained: false, remaining }` so the caller can log and exit anyway (the
 * boot sweep reconciles what's left).
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
