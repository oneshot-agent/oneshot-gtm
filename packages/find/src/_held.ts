import { isLocalPaymentRefusal, isSettlementAmbiguous, logEvent } from "@oneshot-gtm/core";
import type { CallContext } from "@oneshot-gtm/core";

/**
 * A new uncertain paid outcome rethrows: the run stops spending. A call
 * refused locally because the same input is already held (nothing was sent
 * or paid) returns true instead, and the caller skips just this candidate.
 * Measured 2026-11: one held verifyEmail failed 41 local-business runs in a row.
 */
export function skippedHeld(ctx: CallContext, call: string, err: unknown): boolean {
  if (!isSettlementAmbiguous(err)) return false;
  if (!isLocalPaymentRefusal(err)) throw err;
  logEvent(
    "finder.skipped_held",
    { name: ctx.playName, method: call, key: (err as { holdKey?: string }).holdKey },
    "warn",
  );
  return true;
}

// Sentinels a safe wrapper returned for a held call: the contact spine keeps
// them off the breaker, since the call never reached OneShot.
const heldSentinels = new WeakSet<object>();

/** True when a safe wrapper returned this sentinel because its call was held. */
export function wasHeld(res: object): boolean {
  return heldSentinels.has(res);
}

export function markHeld<T extends object>(isHeld: boolean, res: T): T {
  if (isHeld) heldSentinels.add(res);
  return res;
}
