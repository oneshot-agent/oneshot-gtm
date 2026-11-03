import { LINKEDIN_SEND_PENDING } from "@oneshot-gtm/shared-types";
import { linkedInError } from "./linkedin-error.ts";
import type { LinkedInOperation } from "./linkedin-sdk.ts";

/**
 * A LinkedIn send (message, invite, withdrawal) is started with `wait: false`
 * and then polled here with the `wait` operation, one short call at a time.
 * OneShot paces message sends per account, so a job can run for minutes; no
 * single call may outlive the cross-workspace worker's limit.
 */

/** How long a caller polls before the outcome is "pending" (never "failed"). */
export const LINKEDIN_JOB_DEADLINE_MS = 3 * 60_000;
const LINKEDIN_JOB_PAUSE_MS = 3_000;

let timing = { deadlineMs: LINKEDIN_JOB_DEADLINE_MS, pauseMs: LINKEDIN_JOB_PAUSE_MS };

/** Test hook: shorten the deadline and the pause between polls. No argument restores both. */
export function _setLinkedInJobTimingForTests(next?: { deadlineMs?: number; pauseMs?: number }) {
  timing = {
    deadlineMs: next?.deadlineMs ?? LINKEDIN_JOB_DEADLINE_MS,
    pauseMs: next?.pauseMs ?? LINKEDIN_JOB_PAUSE_MS,
  };
}

export type LinkedInJobOutcome =
  | { state: "done"; result: Record<string, unknown> }
  /** Accepted and still running at the deadline: it may yet go out. */
  | { state: "pending"; requestId: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The request id of an answer that is an accepted, unfinished job, by the
 * SDK's own rule for a `wait: false` answer; null for a finished result.
 */
export function linkedInJobInFlight(answer: unknown): string | null {
  const r = asRecord(answer);
  const status = r?.["status"];
  const id = r?.["request_id"];
  return (status === "pending" || status === "processing") && typeof id === "string" && id
    ? id
    : null;
}

/**
 * The finished result of a LinkedIn send. `first` is the send's own answer
 * (or `{status: "pending", request_id}` to resume a job already started).
 * A failed job throws its JobError (code, jobError, partialResult); a job
 * still running at the deadline, or one the polls could not read, is
 * `pending`: it was accepted, so it is never reported as failed.
 */
export async function awaitLinkedInJob(
  first: unknown,
  call: (operation: LinkedInOperation) => Promise<unknown>,
): Promise<LinkedInJobOutcome> {
  const requestId = linkedInJobInFlight(first);
  if (!requestId) return { state: "done", result: asRecord(first) ?? {} };
  const deadline = Date.now() + timing.deadlineMs;
  for (;;) {
    try {
      // `wait` answers within a few seconds: the result once the job is done.
      const answer = await call({ kind: "wait", requestId });
      return { state: "done", result: { ...asRecord(answer), request_id: requestId } };
    } catch (err) {
      // JobTimeoutError: still running. Anything but a failed job (a lost
      // worker, a network error) leaves the job's outcome unknown.
      if ((err as { name?: unknown }).name === "JobError") throw err;
    }
    if (Date.now() + timing.pauseMs >= deadline) return { state: "pending", requestId };
    await new Promise((resolve) => setTimeout(resolve, timing.pauseMs));
  }
}

/**
 * The original request of a send whose key already ran: OneShot's 409
 * `duplicate_request` names it. Null for any other error.
 */
export function linkedInDuplicateRequestId(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = linkedInError(err);
  return e.statusCode === 409 && e.code === "duplicate_request" && e.requestId ? e.requestId : null;
}

/**
 * A send's first answer. A 409 `duplicate_request` (the key already ran)
 * becomes that original job, which the caller polls like its own: nothing
 * is sent a second time.
 */
export async function startLinkedInSend(send: () => Promise<unknown>): Promise<unknown> {
  try {
    return await send();
  } catch (err) {
    const original = linkedInDuplicateRequestId(err);
    if (original) return { status: "pending", request_id: original };
    throw err;
  }
}

/**
 * A withdrawal, polled like a send. Still running at the deadline it throws:
 * the callers retry later with the same idempotency key, which returns the
 * same job, so nothing is withdrawn twice. A failed job is retried under a
 * new key (LinkedInSendAttemptStore).
 */
export async function withdrawLinkedInInvite(
  call: (operation: LinkedInOperation) => Promise<unknown>,
  operation: Extract<LinkedInOperation, { kind: "withdraw" }>,
): Promise<{ status?: string }> {
  const job = await awaitLinkedInJob(await startLinkedInSend(() => call(operation)), call);
  if (job.state === "pending") {
    throw new Error("LinkedIn has not finished the withdrawal yet; the next try checks it again");
  }
  return job.result as { status?: string };
}

/**
 * A send OneShot accepted whose outcome was not known when the caller stopped
 * waiting. Not a failure: the caller records it as pending, and a retry with
 * the same idempotency key checks the job instead of sending again.
 */
export class LinkedInSendPendingError extends Error {
  readonly requestId: string;
  readonly idempotencyKey: string;
  constructor(requestId: string, idempotencyKey: string) {
    super(LINKEDIN_SEND_PENDING);
    this.name = "LinkedInSendPendingError";
    this.requestId = requestId;
    this.idempotencyKey = idempotencyKey;
  }
}

export function isLinkedInSendPending(err: unknown): err is LinkedInSendPendingError {
  return (err as { name?: unknown } | null)?.name === "LinkedInSendPendingError";
}

/** What OneShot's recover endpoint says about a submission, reduced to what GTM acts on. */
export interface LinkedInRecovery {
  /** `unknown`: no submission under the key (or an answer GTM can't read). */
  state: "completed" | "failed" | "in_flight" | "unknown";
  requestId: string | null;
  /** An invite's invitation id, when the answer names one. */
  invitationId: string | null;
}

/**
 * Read a `recover` answer: `{status, request_id, linkedin: {action,
 * invitation_id?, ...}}`. It carries no message result (no conversation id):
 * the finished job is read with `wait` on `request_id`.
 */
export function parseLinkedInRecovery(answer: unknown): LinkedInRecovery {
  const r = asRecord(answer);
  const linkedin = asRecord(r?.["linkedin"]);
  const requestId = typeof r?.["request_id"] === "string" ? (r["request_id"] as string) : null;
  const invitationId =
    typeof linkedin?.["invitation_id"] === "string" ? (linkedin["invitation_id"] as string) : null;
  const status = r?.["status"];
  const state =
    status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : status === "pending" || status === "processing" || status === "queued"
          ? "in_flight"
          : "unknown";
  return { state: requestId || state === "unknown" ? state : "unknown", requestId, invitationId };
}
