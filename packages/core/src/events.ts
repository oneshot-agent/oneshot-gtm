import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configDir } from "./config.ts";

/**
 * Local-only structured event log — one JSON line per event appended to
 * ~/.oneshot-gtm/events.jsonl (`tail -f … | jq` to watch).
 *
 * Privacy boundary (call-site discipline, not enforced programmatically):
 * `ctx` may carry primitives, counters, durations, labels, error class names,
 * hostname/domain — NEVER user-typed values, prospect data, or verbatim LLM
 * completions. Logging never throws; on any failure the event drops silently.
 */

type EventLevel = "debug" | "info" | "warn" | "error";

interface DevEvent {
  ts: string;
  kind: string;
  level: EventLevel;
  ctx?: Record<string, unknown>;
  /** Anonymous per-install id; resolved lazily so tests can mock it. */
  client_id?: string;
  /** Groups all events emitted within one "run" (one watch tick, one HTTP request, one CLI invocation). */
  run_id?: string;
}

const EVENTS_PATH = join(configDir(), "events.jsonl");
const DEBUG_ENABLED = (process.env["DEBUG"] ?? "").includes("oneshot");

let runId: string | null = null;
let cachedClientId: string | null = null;
let clientIdResolved = false;
let configDirEnsured = false;

/**
 * Begin a new "run" — subsequent events emitted from this process will share
 * the returned run_id until the next call. Useful for grouping with jq:
 *   jq 'select(.run_id == "abc-…")'
 */
export function startRun(): string {
  runId = randomUUID();
  return runId;
}

export function logEvent(
  kind: string,
  ctx?: Record<string, unknown>,
  level: EventLevel = "info",
): void {
  // Whole body is best-effort; a logging bug must not break the caller.
  // buildEventLine can throw on BigInt / circular refs (JSON.stringify), so
  // it goes inside the try block alongside the filesystem work.
  try {
    const line = buildEventLine(kind, ctx, level, runId, resolveClientId(), new Date());

    if (!configDirEnsured) {
      if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
      configDirEnsured = true;
    }
    appendFileSync(EVENTS_PATH, line);

    if (DEBUG_ENABLED) {
      // Mirror to stderr so it doesn't interleave with command output on stdout.
      process.stderr.write(line);
    }
  } catch {
    // dropped silently — see file header
  }
}

/**
 * Pure builder for one JSONL line (trailing newline included, so the caller
 * appends in a single syscall). `now`/`runId`/`clientId` are parameters so
 * tests can pin them.
 */
export function buildEventLine(
  kind: string,
  ctx: Record<string, unknown> | undefined,
  level: EventLevel,
  runId: string | null,
  clientId: string | null,
  now: Date,
): string {
  const event: DevEvent = {
    ts: now.toISOString(),
    kind,
    level,
  };
  if (ctx) event.ctx = ctx;
  if (clientId) event.client_id = clientId;
  if (runId) event.run_id = runId;
  return JSON.stringify(event) + "\n";
}

/**
 * Reads clientId straight from config.json — loadConfig() would create a
 * circular import. Returns null when the file doesn't exist yet.
 */
function resolveClientId(): string | null {
  // First call resolves and caches — even a null result — so a missing config
  // never becomes a per-event file read.
  if (clientIdResolved) return cachedClientId;
  clientIdResolved = true;
  try {
    const path = join(configDir(), "config.json");
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { clientId?: string };
    cachedClientId = typeof parsed.clientId === "string" ? parsed.clientId : null;
  } catch {
    cachedClientId = null;
  }
  return cachedClientId;
}

/**
 * Test-only escape hatch. Lets vitest reset the cached id between cases when
 * it manipulates the underlying config file. Not exported via the package
 * barrel — import directly if you really need it.
 */
export function _resetClientIdCacheForTests(): void {
  cachedClientId = null;
  clientIdResolved = false;
  configDirEnsured = false;
  runId = null;
}
