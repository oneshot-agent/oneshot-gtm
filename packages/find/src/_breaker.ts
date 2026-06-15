import { logEvent } from "@oneshot-gtm/core";

/**
 * Process-wide circuit breaker for OneShot paid contact-resolution calls
 * (findEmail/verifyEmail). During a backend outage EVERY candidate's resolution
 * throws; without this, a run burns ~70s + spend per candidate draining all of
 * them through doomed calls (and drops each as if it were a bad candidate).
 *
 * State machine (closed → open → half-open → closed/open):
 * - CLOSED: calls flow normally. `isCircuitOpen()` → false.
 * - OPEN: trips after N consecutive platform errors. `isCircuitOpen()` → true,
 *   so `resolveAndVerifyContact` short-circuits (no spend) for COOLDOWN_MS.
 * - HALF-OPEN: once the cooldown elapses, `isCircuitOpen()` → false again so the
 *   next resolution issues a real probe call. That call's outcome either CLOSES
 *   the breaker (success) or RE-ARMS the cooldown (failure) — so a sustained
 *   outage keeps short-circuiting between probes instead of hammering, and a
 *   recovered backend closes the breaker on the first probe. Without the
 *   cooldown the breaker would latch open forever (nothing calls
 *   recordResolutionOutcome while open), permanently breaking finders until a
 *   process restart.
 *
 * The counter is process-wide and only platform errors (`status:"error"` from
 * the safe wrappers) count toward tripping; any genuine outcome resets it, so a
 * run of legitimately-unresolvable candidates never opens it.
 */
const THRESHOLD = 5;
export const COOLDOWN_MS = 60_000;
let consecutivePlatformErrors = 0;
let open = false;
let openedAt = 0;

/** Record one resolution outcome. `isPlatformError` = the backend threw/timed out. */
export function recordResolutionOutcome(isPlatformError: boolean): void {
  if (isPlatformError) {
    consecutivePlatformErrors++;
    if (!open && consecutivePlatformErrors >= THRESHOLD) {
      open = true;
      openedAt = Date.now();
      logEvent(
        "finder.circuit_open",
        { consecutive: consecutivePlatformErrors, reason: "oneshot resolution unavailable" },
        "warn",
      );
    } else if (open) {
      // A half-open probe failed (or errors kept landing while open) — re-arm
      // the cooldown so we short-circuit again instead of hammering.
      openedAt = Date.now();
    }
  } else {
    if (open) logEvent("finder.circuit_reset", {});
    consecutivePlatformErrors = 0;
    open = false;
  }
}

/**
 * True while the breaker is open AND within the cooldown — callers short-circuit
 * (skip paid resolution, defer). Returns false once the cooldown elapses
 * (half-open: let the next call probe for recovery) or when fully closed.
 */
export function isCircuitOpen(): boolean {
  if (!open) return false;
  return Date.now() - openedAt < COOLDOWN_MS;
}

/** Test-only: reset breaker state between cases. */
export function _resetBreaker(): void {
  consecutivePlatformErrors = 0;
  open = false;
  openedAt = 0;
}
