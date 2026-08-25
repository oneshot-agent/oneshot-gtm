import { readPackageVersion, reportTelemetryEvent, type TelemetryOutcome } from "@oneshot-gtm/core";

/**
 * Server-side telemetry, delegating to core's `reportTelemetryEvent`. Differs
 * from the CLI path in two deliberate ways: `outcome` is passed explicitly
 * (the `markTelemetryOutcome` global is unsafe under concurrent executions),
 * and `command` carries a `server.` prefix to separate the channels.
 * Best-effort and non-blocking — a telemetry failure must never affect a
 * request or the scheduler.
 */

// Resolved lazily (on first emit) rather than at module load: tests mock
// @oneshot-gtm/core wholesale, and a top-level call to a mocked-away export
// would throw during import.
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
  // Every call site `void`s this, so it must never reject.
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
