import { loadConfig } from "./config.ts";
import { getLedger } from "./ledger.ts";
import { todayStartSqliteUtc } from "./send-routing.ts";

/**
 * Install-wide daily USD spend ceiling (issue #481). Per-run caps
 * (`maxCostUsd` on a finder, `maxSpendPerRun` on x-reposters) bound one
 * automated call; this bounds the SUM of every automated paid call —
 * finder trigger runs (scheduled AND ad-hoc "run now") plus automatic
 * drains — over the local calendar day. Manual `/queue` row actions
 * (approve, reject, mark-sent, send-draft) never consult this: a founder
 * reviewing and sending ONE email by hand is a deliberate decision the
 * ceiling should never block.
 *
 * Two numbers make up "effective" spend for the day:
 *  - `spentUsd`   — already-posted receipts (`receipts.cost_usd`, the same
 *                   column every other spend rollup in this codebase reads).
 *  - `reservedUsd` — amounts held by calls CURRENTLY in flight, via
 *                    `reserveSpend`/`releaseSpendReservation`. Without this,
 *                    two automated calls racing the same tick could both
 *                    read "today's spend" as $0 and both start, together
 *                    blowing past the ceiling before either one's receipts
 *                    post. The reservation is released the instant the call
 *                    ends (success, failure, or halt) — actual spend is
 *                    already reflected in `receipts` by then, so releasing
 *                    promptly never double-counts.
 *
 * Both figures are windowed from local midnight (`todayStartSqliteUtc`,
 * the same boundary `send-routing.ts` uses for per-identity daily caps), so
 * this guardrail and the per-identity send caps agree about when a new day
 * starts and reset together.
 */

/** A held-open reservation older than this is presumed orphaned by a crashed process and swept. */
const SPEND_RESERVATION_STALE_MS = 2 * 3600 * 1000;

/**
 * Reservation estimate for an automated call whose own config doesn't state
 * a spend cap (e.g. `breakup-revive`, which is ledger-only and spends
 * nothing) — small on purpose so a truly free finder can't starve the day's
 * budget for other finders on the tiny chance it collides with a paid one.
 */
export const DEFAULT_SPEND_RESERVATION_USD = 1;

/**
 * Worst-case per-row reservation for an automatic drain call. Drain rows are
 * already enriched (email found + verified) at enqueue time, so a drain's
 * per-row cost is just drafting (LLM) + send — the low end of the "$0.05-$2
 * per outbound touch" range this repo's own launch copy quotes — not a fresh
 * finder's per-candidate discovery + enrichment cost.
 */
export const DEFAULT_DRAIN_ROW_RESERVATION_USD = 0.05;

export interface DailySpendStatus {
  /** The configured ceiling, or null when unlimited (default). */
  ceilingUsd: number | null;
  /** Sum of posted receipts since local midnight. */
  spentUsd: number;
  /** Sum of currently-held reservations since local midnight. */
  reservedUsd: number;
  /** spentUsd + reservedUsd — what the ceiling is actually compared against. */
  effectiveUsd: number;
  /** ceilingUsd - effectiveUsd, floored at 0; null when unlimited. */
  remainingUsd: number | null;
  /** True when effectiveUsd has reached (>=) the ceiling. Always false when unlimited. */
  ceilingReached: boolean;
}

/** Current daily spend status. Pure read — never mutates reservations. */
export function dailySpendStatus(now = new Date()): DailySpendStatus {
  const ceilingUsd = loadConfig().dailySpendCeilingUsd;
  const sinceIso = todayStartSqliteUtc(now);
  const ledger = getLedger();
  const spentUsd = ledger.totalSpendUsd({ sinceIso });
  const reservedUsd = ledger.reservedSpendUsd(sinceIso);
  const effectiveUsd = spentUsd + reservedUsd;
  const remainingUsd = ceilingUsd == null ? null : Math.max(0, ceilingUsd - effectiveUsd);
  return {
    ceilingUsd,
    spentUsd,
    reservedUsd,
    effectiveUsd,
    remainingUsd,
    ceilingReached: ceilingUsd != null && effectiveUsd >= ceilingUsd,
  };
}

/** The named reason string surfaced on trigger cards, in `doctor`, and in drain output. */
export function spendCeilingReason(status: DailySpendStatus): string {
  return `daily spend ceiling reached ($${status.spentUsd.toFixed(2)}/$${(status.ceilingUsd ?? 0).toFixed(2)} spent today)`;
}

export type SpendReservationOutcome =
  | { granted: true; release: () => void; status: DailySpendStatus }
  | { granted: false; reason: string; status: DailySpendStatus };

/**
 * Gate + reserve in one call: the shared entry point for every automated
 * paid path (finder trigger runs, automatic drains). Sweeps orphaned
 * reservations first so a crashed process can't hold spend hostage for the
 * rest of the day, then checks the ceiling BEFORE reserving — a call that
 * would push effective spend at/over the ceiling is refused outright rather
 * than reserved-then-immediately-over.
 *
 * `estimateUsd` should be the caller's own worst-case bound for this one
 * call (a finder's `maxCostUsd`, a drain's conservative per-batch estimate)
 * — it only needs to be good enough to close the race between two
 * concurrently-starting automated calls; actual spend is what ultimately
 * lands in `receipts` regardless of the estimate.
 */
export function tryReserveDailySpend(
  estimateUsd: number,
  now = new Date(),
): SpendReservationOutcome {
  const ledger = getLedger();
  ledger.sweepStaleSpendReservations(SPEND_RESERVATION_STALE_MS, now);
  const status = dailySpendStatus(now);
  // Refuse when EITHER the ceiling is already reached OR this call's own
  // worst-case estimate would push effective spend at/over it. Checking
  // `status.ceilingReached` alone (the current effective spend) is not
  // enough: two concurrent calls can each pass that check against the SAME
  // pre-reservation total and both reserve, together blowing past the
  // ceiling before either one's estimate is accounted for. Folding the
  // incoming estimate into the comparison is what actually closes the race.
  const wouldExceed =
    status.ceilingUsd != null &&
    status.effectiveUsd + Math.max(0, estimateUsd) >= status.ceilingUsd;
  if (status.ceilingReached || wouldExceed) {
    return { granted: false, reason: spendCeilingReason(status), status };
  }
  const id = ledger.reserveSpend(Math.max(0, estimateUsd));
  let released = false;
  return {
    granted: true,
    status,
    release: () => {
      if (released) return; // idempotent — a finally + an explicit release must not double-delete
      released = true;
      ledger.releaseSpendReservation(id);
    },
  };
}
