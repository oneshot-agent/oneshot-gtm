import { useEffect, useState } from "react";

/**
 * Per-trigger "is running" tracker persisted to localStorage, so a mid-run
 * refresh preserves the spinner. Entries are cleared when the server
 * confirms completion (lastPolledAt > startedAt and MIN_VISIBLE_MS has
 * elapsed), or when MAX_RUNTIME_MS zombie-cleans them.
 *
 * Storage: localStorage["oneshot-gtm:trigger-running:<name>"] = "<unix-ms>"
 */
const KEY_PREFIX = "oneshot-gtm:trigger-running:";
/**
 * Client-side zombie cleanup for the localStorage spinner marker. Set to
 * 4h to match `MAX_RUN_AGE_MS` in @oneshot-gtm/find — generous headroom
 * over realistic finder runtimes (github-topics with concurrency=3 typically
 * completes in 5-15 min; the deepResearchPerson tier sets the upper bound
 * at 2-5 min per call). The spinner shouldn't disappear mid-run on a
 * genuinely-long execution.
 */
const MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;
/**
 * Minimum visible duration after a click. Without this floor the
 * unconfigured-halt + ledger-only finders complete in <10ms, flipping the
 * button back to "run now" before the user perceives the spinner.
 */
const MIN_VISIBLE_MS = 1500;

export function markTriggerRunning(name: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + name, String(Date.now()));
  } catch {
    // private mode / SSR — no-op
  }
}

export function clearTriggerRunning(name: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + name);
  } catch {
    // ignore
  }
}

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
 * Merge local (localStorage) + server (`runningSince` from the triggers
 * poll) start times into a per-name running map with a live-ticking
 * elapsedMs. Local wins when both are present; server fills in for fresh
 * tabs that never set a marker.
 */
export function useRunningTriggers(
  names: string[],
  lastPolledByName: Map<string, string | null>,
  serverRunningSinceByName: Map<string, string | null>,
): Map<string, RunningInfo> {
  const [tick, setTick] = useState(0);
  // Only run the 1s elapsed-counter tick while something is actually running —
  // an idle page shouldn't re-render every second. Re-subscribes when the
  // boolean flips (a run starts/finishes).
  const anyRunning = names.some(
    (name) => readStartedAt(name) != null || (serverRunningSinceByName.get(name) ?? null) != null,
  );
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const out = new Map<string, RunningInfo>();
  const now = Date.now();
  for (const name of names) {
    const localStartedAt = readStartedAt(name);
    const serverSinceIso = serverRunningSinceByName.get(name);
    const serverStartedAt = serverSinceIso ? new Date(serverSinceIso).getTime() : null;
    const startedAt = localStartedAt ?? serverStartedAt;
    if (startedAt == null) continue;

    if (localStartedAt != null) {
      const polledIso = lastPolledByName.get(name);
      const polledMs = polledIso ? new Date(polledIso).getTime() : 0;
      const visibleFor = now - localStartedAt;
      if (polledMs > localStartedAt && visibleFor >= MIN_VISIBLE_MS) {
        clearTriggerRunning(name);
        if (serverStartedAt != null && serverStartedAt > polledMs) {
          out.set(name, { startedAt: serverStartedAt, elapsedMs: now - serverStartedAt });
        }
        continue;
      }
      if (visibleFor > MAX_RUNTIME_MS) {
        clearTriggerRunning(name);
        continue;
      }
    }

    out.set(name, { startedAt, elapsedMs: now - startedAt });
  }
  // Ref `tick` so the elapsed counter re-computes on the interval.
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
