import type { OneShotConfig } from "./types.ts";

/**
 * Anonymous distribution telemetry — ONE summary event per CLI invocation.
 *
 * This is a separate channel from the verbose local `events.jsonl`
 * (see events.ts). That log is for the developer and never leaves the
 * machine; this is the opt-out, off-device signal documented in
 * TELEMETRY.md. The two share a privacy boundary (primitives, counters,
 * category labels — never user-typed values, prospect data, or content)
 * but emit different shapes to different sinks.
 *
 * TELEMETRY.md is the authoritative spec for the payload below. The field
 * set here must stay in lockstep with that file.
 *
 * ## Hard rules
 *
 * - `ONESHOT_GTM_TELEMETRY=0` / `false` is a kill switch checked BEFORE a
 *   payload is constructed (`shouldSendTelemetry`). No payload, no request.
 * - `cfg.telemetryEnabled === false` (the `config telemetry off` flag) does
 *   the same.
 * - Transmission never throws and never blocks process exit — a telemetry
 *   bug or an unreachable endpoint must be invisible to the user.
 * - No telemetry SDK: a plain `fetch` POST keeps the OSS client dependency
 *   free and transparent. The receiver (Cloud Run + BigQuery) is first-party.
 */

/** Outcome of a single CLI invocation. Mirrors the TELEMETRY.md `outcome` column. */
export type TelemetryOutcome = "ok" | "error" | "lint-blocked";

/**
 * The exact wire shape. Field set is the TELEMETRY.md whitelist — do not add
 * fields here without updating that file in the same change.
 */
export interface TelemetryPayload {
  command: string;
  flags: string[];
  outcome: TelemetryOutcome;
  duration_ms: number;
  version: string;
  os: string;
  bun_version: string;
  /**
   * Anonymous per-install id. Satisfied by the existing `clientId` UUID
   * (config.json) rather than a machine fingerprint — random-per-install,
   * already persisted, and carries nothing PII-adjacent.
   */
  anonymous_machine_id: string | null;
  llm_provider: string;
}

/**
 * Default first-party ingest endpoint. Intentionally EMPTY in the public
 * source so no internal infrastructure identifier (GCP project, Cloud Run
 * host) ships in the OSS client, and so a fork/local build sends nowhere by
 * default. A maintainer sets this to a stable custom domain they control
 * (e.g. "https://telemetry.example.com/v1/cli") for a release; operators can
 * override per-run with ONESHOT_GTM_TELEMETRY_URL. Empty ⇒ telemetry is a
 * no-op (nothing is constructed or sent).
 */
export const DEFAULT_TELEMETRY_URL = "";

const TELEMETRY_TIMEOUT_MS = 1500;

/**
 * Resolve the ingest URL. `ONESHOT_GTM_TELEMETRY_URL` overrides the default
 * so the receiver can be exercised locally / against staging.
 */
export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ONESHOT_GTM_TELEMETRY_URL"]?.trim();
  return override && override.length > 0 ? override : DEFAULT_TELEMETRY_URL;
}

/**
 * Pure gate. Returns false — meaning "construct nothing, send nothing" — when
 * either the persisted flag is off or the env kill switch is set. Env wins so
 * a single shell-session export reliably silences telemetry regardless of
 * what's on disk.
 */
export function shouldSendTelemetry(
  cfg: Pick<OneShotConfig, "telemetryEnabled">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["ONESHOT_GTM_TELEMETRY"]?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return cfg.telemetryEnabled !== false;
}

export interface TelemetryInputs {
  command: string;
  flags: string[];
  outcome: TelemetryOutcome;
  durationMs: number;
  version: string;
  clientId: string | null;
  llmProvider: string;
  platform: string;
  bunVersion: string;
}

/**
 * Pure builder — no I/O, no clock, no globals. The caller supplies every
 * value so tests can pin them (mirrors `buildEventLine`). Strips nothing:
 * the field set IS the whitelist, so anything not listed simply can't be
 * carried.
 */
export function buildTelemetryPayload(input: TelemetryInputs): TelemetryPayload {
  return {
    command: input.command,
    flags: input.flags,
    outcome: input.outcome,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    version: input.version,
    os: input.platform,
    bun_version: input.bunVersion,
    anonymous_machine_id: input.clientId,
    llm_provider: input.llmProvider,
  };
}

/**
 * Fire-and-forget POST. Resolves either way — a network error, a non-2xx, or
 * the timeout all resolve to undefined. Bounded by an AbortController so a
 * hung endpoint can't delay CLI exit beyond TELEMETRY_TIMEOUT_MS.
 */
export async function reportCommand(
  payload: TelemetryPayload,
  url: string = telemetryUrl(),
): Promise<void> {
  // No endpoint configured ⇒ no-op. Keeps unconfigured/forked builds silent
  // and avoids a guaranteed-failing fetch on every command.
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // swallowed — telemetry must never surface to the user (see header)
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Per-invocation outcome marker.
//
// Most commands map cleanly: a thrown error => "error", a clean return =>
// "ok". But the anti-slop path prints "Not sent — fix lint flags" and returns
// normally (printDrafts in motion.ts), so "lint-blocked" can't be inferred
// from control flow. A command signals it explicitly via markTelemetryOutcome;
// the dispatch wrapper reads it back with takeMarkedOutcome.
// ---------------------------------------------------------------------------

let markedOutcome: TelemetryOutcome | null = null;

/** Override the inferred outcome for the current invocation (e.g. "lint-blocked"). */
export function markTelemetryOutcome(outcome: TelemetryOutcome): void {
  markedOutcome = outcome;
}

/** Read and clear the marked outcome. Returns null if nothing was marked. */
export function takeMarkedOutcome(): TelemetryOutcome | null {
  const o = markedOutcome;
  markedOutcome = null;
  return o;
}
