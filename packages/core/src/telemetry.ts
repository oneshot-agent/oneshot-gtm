import { loadConfig } from "./config.ts";
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
 * Default first-party ingest endpoint. A stable custom domain we own (mapped
 * onto a Cloud Run service) rather than the raw `*.run.app` host — so the
 * backend can move without re-shipping the client, and no GCP project number
 * leaks into the OSS source. Operators can override per-run with
 * ONESHOT_GTM_TELEMETRY_URL; set it to "" to make telemetry a hard no-op.
 */
export const DEFAULT_TELEMETRY_URL = "https://telemetry.oneshotagent.com/v1/cli";

// Bounds the worst-case hang on a dead/captive network. The in-flight fetch
// keeps the event loop alive until it settles, so on the CLI this is also the
// ceiling on how long a command's exit can be delayed by telemetry. Kept tight:
// a healthy send is ~100-300ms; past 1s we'd rather drop the event than make
// the user wait.
const TELEMETRY_TIMEOUT_MS = 1000;

/**
 * Resolve the ingest URL. `ONESHOT_GTM_TELEMETRY_URL` overrides the default so
 * the receiver can be exercised locally / against staging. An *explicitly
 * empty* override (`ONESHOT_GTM_TELEMETRY_URL=""`) resolves to `""` — a hard
 * no-op (see reportCommand's `if (!url) return`) — honoring the documented kill
 * path. Only an absent var falls back to the default endpoint.
 */
export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["ONESHOT_GTM_TELEMETRY_URL"];
  if (raw === undefined) return DEFAULT_TELEMETRY_URL;
  return raw.trim();
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
 * executions). Resolves the endpoint + opt-out gate, reads the anonymous
 * install id / provider from config, stamps host fields (os, bun), and fires.
 * Best-effort: never throws, never blocks the caller. Centralizing this keeps
 * the CLI and server channels from drifting as the payload evolves.
 */
export async function reportTelemetryEvent(
  input: TelemetryEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const url = telemetryUrl(env);
    // No endpoint configured ⇒ skip everything, including the config read.
    if (!url) return;
    const cfg = loadConfig();
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
