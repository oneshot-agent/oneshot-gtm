import { readPackageVersion, reportTelemetryEvent, type TelemetryOutcome } from "@oneshot-gtm/core";

/**
 * Server-side telemetry — the dashboard analogue of the CLI's per-command
 * event (see apps/cli/src/index.ts `sendTelemetry`). The server executes the
 * same kinds of work (plays, cadence sends, queue drains, scheduled triggers)
 * but never passes through the CLI's `runOrFail`, so it reports here instead.
 *
 * Delegates the gate + payload + send to `reportTelemetryEvent` in core (the
 * shared path the CLI also uses); this wrapper only supplies the server's own
 * `version` and an empty-flags default. Two deliberate differences from the
 * CLI path:
 *
 *  1. `outcome` is passed in explicitly rather than read from the
 *     `markTelemetryOutcome` global — that singleton is unsafe in a concurrent
 *     server where many executions overlap.
 *  2. `command` is prefixed `server.` so the events table can separate CLI
 *     and server channels (filter on a `server.` prefix).
 *
 * Best-effort and non-blocking: `reportTelemetryEvent` never throws and has its
 * own timeout, so a telemetry failure can't affect a request or the scheduler.
 */

// Resolved lazily (on first emit) rather than at module load: this module is
// imported by routes/scheduler whose tests sometimes mock @oneshot-gtm/core
// wholesale, and a top-level call to a (possibly-mocked-away) core export would
// throw during import. Inside reportServerExecution it's covered by the catch.
let serverVersion: string | undefined;

export interface ServerExecutionOpts {
  outcome: TelemetryOutcome;
  durationMs: number;
  /** Flag-style labels only (e.g. "scheduled", "dry-run") — never values. */
  flags?: string[];
}

/**
 * Emit one anonymous telemetry event for a server-initiated execution.
 * `command` should already carry the `server.` prefix (e.g. `server.run.show-hn`).
 */
export async function reportServerExecution(
  command: string,
  opts: ServerExecutionOpts,
): Promise<void> {
  // Defensive: every call site `void`s this, so it must never reject —
  // `reportTelemetryEvent` is already best-effort, but this guards the
  // delegation itself (e.g. a partially-mocked core in tests).
  try {
    serverVersion ??= readPackageVersion(import.meta.url);
    await reportTelemetryEvent({
      command,
      flags: opts.flags ?? [],
      outcome: opts.outcome,
      durationMs: opts.durationMs,
      version: serverVersion,
    });
  } catch {
    // never surface to a request or the scheduler loop
  }
}
