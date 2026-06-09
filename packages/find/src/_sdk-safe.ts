import { findEmail, logEvent, verifyEmail } from "@oneshot-gtm/core";
import type { CallContext, FindEmailInput, VerifyEmailInput } from "@oneshot-gtm/core";

/**
 * Per-candidate-safe wrappers for the two job-based contact-resolution SDK calls.
 *
 * Finders process candidates concurrently via `parallelMap` (errors propagate
 * through Promise.all) or in sequential loops. An unguarded throw from one
 * candidate's `findEmail`/`verifyEmail` — e.g. a OneShot backend job timeout —
 * rejects the whole batch and aborts the entire trigger run. These wrappers
 * swallow the throw, log `error.swallowed`, and return a graceful "not found /
 * not deliverable" sentinel so the caller's existing drop branch handles just
 * that candidate and the run continues. Same pattern as `enrichVerifiedContact`
 * (_enrich.ts) and `findLinkedInUrl` (_linkedin.ts). The full `CallContext` is
 * forwarded unchanged, so audit/decisionContext metadata is preserved.
 */

function swallow(ctx: CallContext, call: string, err: unknown): void {
  logEvent(
    "error.swallowed",
    {
      kind: `${ctx.playName}.${call}`,
      message_120: ((err as Error).message ?? "").slice(0, 120),
    },
    "warn",
  );
}

/** findEmail that never throws — a failure resolves to `found: false` (drop). */
export async function safeFindEmail(
  input: FindEmailInput,
  ctx: CallContext,
): Promise<Awaited<ReturnType<typeof findEmail>>> {
  try {
    return await findEmail(input, ctx);
  } catch (err) {
    swallow(ctx, "find_email", err);
    // cost 0 / receiptId 0 mirror the cache-miss sentinels in _enrich.ts.
    return { result: { status: "error", email: null, found: false, cost: 0 }, receiptId: 0 };
  }
}

/** verifyEmail that never throws — a failure resolves to `deliverable: false` (drop). */
export async function safeVerifyEmail(
  input: VerifyEmailInput,
  ctx: CallContext,
): Promise<Awaited<ReturnType<typeof verifyEmail>>> {
  try {
    return await verifyEmail(input, ctx);
  } catch (err) {
    swallow(ctx, "verify_email", err);
    return {
      result: {
        status: "error",
        email: input.email,
        valid: false,
        deliverable: false,
        catch_all: false,
        disposable: false,
        cost: 0,
      },
      receiptId: 0,
    };
  }
}
