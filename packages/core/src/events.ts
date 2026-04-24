import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configDir } from "./config.ts";

/**
 * Local-only structured event log.
 *
 * Every interesting moment (LLM call, ICP filter decision, finder lifecycle,
 * swallowed errors) appends one JSON line to ~/.oneshot-gtm/events.jsonl.
 * Tail it with `tail -f ~/.oneshot-gtm/events.jsonl | jq` while iterating.
 *
 * ## Privacy boundary
 *
 * `ctx` may contain primitives, counters, durations, category labels, error
 * class names, hostname/domain. It must NEVER contain user-typed values like
 * email addresses or ICP one-liner text, prospect data, or LLM completions
 * verbatim. This is the same boundary that will apply when an opt-in HTTP
 * sink is added later — keeping the rule tight today means schema reuse
 * tomorrow.
 *
 * Not enforced programmatically. Code-review discipline at the call sites.
 *
 * ## Failure mode
 *
 * Logging never throws. A logging bug must not break the caller. If the
 * filesystem is read-only or the config dir doesn't exist, the event is
 * dropped silently.
 */

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface DevEvent {
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
  const event: DevEvent = {
    ts: new Date().toISOString(),
    kind,
    level,
  };
  if (ctx) event.ctx = ctx;
  const cid = resolveClientId();
  if (cid) event.client_id = cid;
  if (runId) event.run_id = runId;

  const line = JSON.stringify(event) + "\n";

  try {
    if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
    appendFileSync(EVENTS_PATH, line);
  } catch {
    // dropped silently — see file header
  }

  if (DEBUG_ENABLED) {
    // Mirror to stderr so it doesn't interleave with command output on stdout.
    process.stderr.write(line);
  }
}

/**
 * Read the clientId straight from config.json instead of going through
 * loadConfig() — that would create a circular import (config doesn't depend
 * on events today; we keep it that way). Survives the case where the file
 * doesn't exist yet: returns null and the event ships without a client_id.
 * Cached for the process lifetime once non-null.
 */
function resolveClientId(): string | null {
  if (clientIdResolved && cachedClientId) return cachedClientId;
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
  runId = null;
}

/** Path the JSONL log lives at — exposed so docs/CLI hints can reference it. */
export function eventsLogPath(): string {
  return EVENTS_PATH;
}
