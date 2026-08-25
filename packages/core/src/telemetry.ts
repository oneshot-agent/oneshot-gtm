import { loadConfigCached } from "./config.ts";
import type { OneShotConfig } from "./types.ts";

/**
 * Anonymous distribution telemetry — ONE summary event per CLI invocation,
 * separate from the local-only events.jsonl channel. TELEMETRY.md is the
 * authoritative payload spec; the field set here must stay in lockstep.
 *
 * Hard rules: the env kill switch (ONESHOT_GTM_TELEMETRY=0) and
 * `cfg.telemetryEnabled === false` are checked BEFORE any payload is built;
 * transmission never throws and never blocks process exit; no telemetry SDK —
 * a plain `fetch` POST to a first-party endpoint.
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
 * Default first-party ingest endpoint. Override per-run with
 * ONESHOT_GTM_TELEMETRY_URL; set it to "" for a hard no-op.
 */
export const DEFAULT_TELEMETRY_URL = "https://telemetry.oneshotagent.com/v1/cli";

// Bounds the worst-case hang on a dead/captive network. The in-flight fetch
// keeps the event loop alive until it settles, so on the CLI this is also the
// ceiling on how long a command's exit can be delayed by telemetry. Kept tight:
// a healthy send is ~100-300ms; past 1s we'd rather drop the event than make
// the user wait.
const TELEMETRY_TIMEOUT_MS = 1000;

/**
 * Resolve the ingest URL. An *explicitly empty* ONESHOT_GTM_TELEMETRY_URL=""
 * resolves to "" — a hard no-op; only an absent var falls back to the default.
 */
export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["ONESHOT_GTM_TELEMETRY_URL"];
  if (raw === undefined) return DEFAULT_TELEMETRY_URL;
  return raw.trim();
}

/**
 * Pure gate: false = construct nothing, send nothing. The env kill switch
 * wins over the persisted flag.
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
 * Pure builder — no I/O, no clock, no globals. The field set IS the
 * whitelist, so anything not listed can't be carried.
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

/** One telemetry event, minus the host-resolved fields the helper fills in. */
export interface TelemetryEventInput {
  command: string;
  flags: string[];
  outcome: TelemetryOutcome;
  durationMs: number;
  /** Caller-supplied so each emitter reports its own package version. */
  version: string;
}

/**
 * The single send path shared by every emitter (CLI dispatch, server
 * executions). Best-effort: never throws, never blocks the caller.
 */
export async function reportTelemetryEvent(
  input: TelemetryEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const url = telemetryUrl(env);
    // No endpoint configured ⇒ skip everything, including the config read.
    if (!url) return;
    const cfg = loadConfigCached();
    if (!shouldSendTelemetry(cfg, env)) return;
    const payload = buildTelemetryPayload({
      command: input.command,
      flags: input.flags,
      outcome: input.outcome,
      durationMs: input.durationMs,
      version: input.version,
      clientId: cfg.clientId,
      llmProvider: cfg.llmProvider,
      platform: process.platform,
      bunVersion: typeof Bun !== "undefined" ? Bun.version : "",
    });
    await reportCommand(payload, url);
  } catch {
    // never surface telemetry failures to the caller
  }
}

// Per-invocation outcome marker. "lint-blocked" can't be inferred from
// control flow (the anti-slop path returns normally), so a command signals it
// via markTelemetryOutcome; the dispatch wrapper reads takeMarkedOutcome.

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
