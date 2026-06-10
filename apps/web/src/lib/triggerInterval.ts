/**
 * Helpers for the editable trigger-interval control on /queue.
 *
 * The backend already honors a `config.intervalMs` override per trigger
 * (`effectiveIntervalMs` in packages/find/src/registry.ts — min 60s, invalid
 * values fall back to the spec default). These helpers only shape what the UI
 * writes into the trigger's stored config.
 */

/** Backend floor — `effectiveIntervalMs` ignores overrides below this. */
export const MIN_INTERVAL_MS = 60_000;

const HOUR_MS = 3600_000;

/**
 * Preset choices for the interval editor. Bottoms out at 1h deliberately:
 * sub-hour polling burns LLM/API spend with little new signal for these
 * sources. Power users can still set anything ≥ 60s via the JSON editor.
 */
export const INTERVAL_PRESETS_MS = [
  HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  24 * HOUR_MS,
  48 * HOUR_MS,
  7 * 24 * HOUR_MS,
];

/**
 * Merge an interval override into a trigger's stored config WITHOUT clobbering
 * other keys (topics, cities, …) — `setTriggerConfig` replaces config_json
 * wholesale, so the caller must send the full object back. `null` removes the
 * override (trigger reverts to its registry default). Values are floored and
 * clamped to the backend's 60s minimum so the UI can never write a value the
 * backend would silently ignore.
 */
export function withIntervalOverride(
  config: Record<string, unknown> | null,
  intervalMs: number | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  if (intervalMs == null) {
    delete out["intervalMs"];
    return out;
  }
  out["intervalMs"] = Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs));
  return out;
}
