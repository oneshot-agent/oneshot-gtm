/**
 * Run cancellation primitives, shared by the play executors (which check the
 * signal) and the server (which owns it). Kept in core so `plays` and the
 * server agree on one error identity without either depending on the other.
 */

/**
 * Thrown at a paid-call boundary when the run's AbortSignal has already fired.
 * Deliberately NOT a target failure: `runEmailPlay`'s per-target catch re-raises
 * it (the same escape hatch `SendDeferredError` gets) so a cancelled target
 * never lands as an errorDraft, and the run row ends `cancelled`, not `done`.
 */
export class RunCancelledError extends Error {
  constructor(reason: string = DEFAULT_CANCEL_REASON) {
    super(reason);
    // Explicit name so isRunCancelled works across module instances /
    // serialization boundaries where instanceof would lie.
    this.name = "RunCancelledError";
  }
}

export function isRunCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "RunCancelledError";
}

const DEFAULT_CANCEL_REASON = "run cancelled";

/**
 * Read a human-usable reason off an AbortSignal. `AbortController.abort(x)`
 * takes any value; ours pass a string, but `signal.reason` defaults to a
 * DOMException, so normalize rather than persisting "[object Object]".
 */
export function cancelReasonOf(signal: AbortSignal | undefined): string {
  const raw: unknown = signal?.reason;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (raw instanceof Error && raw.message) return raw.message;
  return DEFAULT_CANCEL_REASON;
}

/**
 * The guard that goes immediately before a paid call. `where` names the call
 * site so the persisted reason says which phase was about to bill. Cheap
 * enough to run per target per phase — the whole point is that nothing bills
 * after the abort.
 */
export function throwIfCancelled(signal: AbortSignal | undefined, where: string): void {
  if (!signal?.aborted) return;
  throw new RunCancelledError(`${where}: ${cancelReasonOf(signal)}`);
}

/**
 * In-flight runs by runId, so `POST /api/run/:runId/cancel` can reach the
 * AbortController owned by the SSE handler that is streaming that run. Process-
 * local by design: a run only exists inside the process that is executing it,
 * and a run stranded by a process exit is the cold-boot sweep's job, not this
 * map's. The SSE handler registers on start and releases in its `finally`, so
 * nothing here outlives the run it belongs to.
 */
const inFlightRuns = new Map<number, AbortController>();

export function registerRunController(runId: number, controller: AbortController): void {
  inFlightRuns.set(runId, controller);
}

export function releaseRunController(runId: number): void {
  inFlightRuns.delete(runId);
}

/**
 * Abort the live run `runId`, if this process is the one running it. Returns
 * false when there is no live controller — the caller (the cancel route) then
 * knows the row is either already terminal or orphaned, and writes the ledger
 * itself instead of waiting for a handler that will never unwind.
 */
export function abortRun(runId: number, reason: string): boolean {
  const controller = inFlightRuns.get(runId);
  if (!controller) return false;
  // Idempotent: aborting an already-aborted controller is a no-op, and the
  // first reason wins — which is the one the run will actually record.
  controller.abort(reason);
  return true;
}

/** Whether this process is currently executing `runId`. Exported for tests. */
export function isRunInFlight(runId: number): boolean {
  return inFlightRuns.has(runId);
}
