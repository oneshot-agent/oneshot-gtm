import { useEffect, useState } from "react";

/**
 * Per-trigger "is running" tracker, persisted to localStorage so a refresh
 * mid-run doesn't lose the spinner. The server-side work continues either
 * way (runTriggerNow writes last_polled_at when done); this just lets the
 * UI show "still running · 1m 12s" instead of falling back to "run now".
 *
 * Storage shape: localStorage["oneshot-gtm:trigger-running:<name>"] = "<unix-ms>"
 *
 * Cleared automatically when:
 *   - the React mutation onSuccess/onError fires (in-process completion)
 *   - the trigger's stored lastPolledAt advances past startedAt (cross-refresh
 *     completion — the work finished while we were gone)
 *   - more than MAX_RUNTIME_MS has passed (zombie cleanup; assume something
 *     went wrong server-side and the client hasn't been notified)
 */
const KEY_PREFIX = "oneshot-gtm:trigger-running:";
const MAX_RUNTIME_MS = 15 * 60 * 1000;

export function markTriggerRunning(name: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + name, String(Date.now()));
  } catch {
    // private mode / SSR — degrades gracefully (no resume but no crash)
  }
}

export function clearTriggerRunning(name: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + name);
  } catch {
    // ignore
  }
}

/**
 * Cheap check used by the triggers query's refetchInterval — bumps polling
 * to a few seconds while anything is in flight, then back to 30s. Reads
 * directly from localStorage so it works even outside React tree.
 */
export function hasAnyRunningTrigger(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function readStartedAt(name: string): number | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + name);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface RunningInfo {
  startedAt: number;
  elapsedMs: number;
}

/**
 * Returns a Map<triggerName, RunningInfo> reflecting which triggers are
 * currently believed to be running. Re-evaluates every TICK_MS so elapsed
 * counters update smoothly.
 *
 * Caller passes `lastPolledByName` so we can clear entries whose work the
 * server has already confirmed done (lastPolledAt > startedAt).
 */
export function useRunningTriggers(
  names: string[],
  lastPolledByName: Map<string, string | null>,
): Map<string, RunningInfo> {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const out = new Map<string, RunningInfo>();
  const now = Date.now();
  for (const name of names) {
    const startedAt = readStartedAt(name);
    if (startedAt == null) continue;

    // Server confirmed completion since we marked it running → clear + skip.
    const polledIso = lastPolledByName.get(name);
    const polledMs = polledIso ? new Date(polledIso).getTime() : 0;
    if (polledMs > startedAt) {
      clearTriggerRunning(name);
      continue;
    }

    // Zombie cleanup — work has been "running" implausibly long.
    if (now - startedAt > MAX_RUNTIME_MS) {
      clearTriggerRunning(name);
      continue;
    }

    out.set(name, { startedAt, elapsedMs: now - startedAt });
  }
  // Reference `tick` so the hook re-runs on each interval; otherwise React
  // would treat the map as stable and never update the elapsed counter.
  void tick;
  return out;
}

export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}
