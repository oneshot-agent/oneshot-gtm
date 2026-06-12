import { loadConfig } from "./config.ts";
import { logEvent } from "./events.ts";
import { LEGACY_GMAIL_ID, LEGACY_ONESHOT_ID, resolveIdentities } from "./identities.ts";
import { getLedger } from "./ledger.ts";
import type { EmailIdentity } from "./types.ts";

/**
 * Thrown by sendEmail (pre-flight, before any network or LLM spend) when
 * every identity in the pool has exhausted its daily cap. Callers treat it
 * as "try again tomorrow": cadence steps stay due, queue rows stay approved.
 */
export class SendDeferredError extends Error {
  constructor(message: string) {
    super(message);
    // Explicit name so isSendDeferred works across module instances /
    // serialization boundaries where instanceof would lie.
    this.name = "SendDeferredError";
  }
}

export function isSendDeferred(err: unknown): boolean {
  return err instanceof Error && err.name === "SendDeferredError";
}

/** "YYYY-MM-DD HH:MM:SS" UTC — the format SQLite's datetime('now') writes into receipts.created_at. */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Start of the founder's current LOCAL calendar day, rendered in the SQLite
 * UTC format the receipts column actually stores. Caps are "per day" in the
 * founder's mental model, so the boundary is local midnight, not UTC.
 */
export function todayStartSqliteUtc(now = new Date()): string {
  const localMidnight = new Date(now);
  localMidnight.setHours(0, 0, 0, 0);
  return toSqliteUtc(localMidnight);
}

const MS_PER_WEEK = 7 * 24 * 3600 * 1000;
const DEFAULT_WARMUP_MAX = 50;

/**
 * Today's send ceiling for an identity. Uncapped (Infinity) only when both
 * maxPerDay and warmup are null. With a warmup ramp, capacity grows from
 * startPerDay by incrementPerWeek for each full week since the identity's
 * first recorded send, clamped to maxPerDay.
 */
export function warmupCap(
  identity: EmailIdentity,
  firstSendAtSqliteUtc: string | null,
  now = new Date(),
): number {
  if (identity.maxPerDay == null && identity.warmup == null) return Infinity;
  const max = identity.maxPerDay ?? DEFAULT_WARMUP_MAX;
  if (!identity.warmup) return max;
  if (!firstSendAtSqliteUtc) return Math.min(identity.warmup.startPerDay, max);
  const firstMs = new Date(`${firstSendAtSqliteUtc.replace(" ", "T")}Z`).getTime();
  const weeks = Number.isFinite(firstMs)
    ? Math.max(0, Math.floor((now.getTime() - firstMs) / MS_PER_WEEK))
    : 0;
  return Math.min(identity.warmup.startPerDay + weeks * identity.warmup.incrementPerWeek, max);
}

function capacityToday(
  identity: EmailIdentity,
  now = new Date(),
): { remaining: number; sent: number } {
  // Early-out for uncapped identities BEFORE any ledger access — legacy
  // single-identity installs must never pay a DB read just to learn "∞".
  if (identity.maxPerDay == null && identity.warmup == null) {
    return { remaining: Infinity, sent: 0 };
  }
  const ledger = getLedger();
  const cap = warmupCap(identity, ledger.firstEmailSendAt(identity.id), now);
  const sent = ledger.countEmailSendsSince(identity.id, todayStartSqliteUtc(now));
  return { remaining: Math.max(0, cap - sent), sent };
}

export function remainingToday(identity: EmailIdentity, now = new Date()): number {
  return capacityToday(identity, now).remaining;
}

/** True when at least one identity can still send today — lets the cadence engine skip LLM drafting on fully capped days. */
export function hasAnySendCapacity(now = new Date()): boolean {
  return resolveIdentities(loadConfig()).some((i) => remainingToday(i, now) > 0);
}

/**
 * Which identity sends to this address. Resolution order:
 *  1. Existing sender_assignments pin → that identity (config error if the
 *     id was removed from the pool — never silently re-route a live thread).
 *  2. No pin but the address was emailed pre-rotation → lazy-pin to the
 *     legacy identity (keeps in-flight cadences on their original From).
 *  3. Fresh prospect → CAPPED identities first: most remaining capacity today,
 *     tie → fewer sends, then pool order. Uncapped identities are the
 *     overflow absorber, used only when every capped one is full — otherwise
 *     an uncapped OneShot identity would always win on remaining capacity
 *     (∞) and the warming Gmail accounts would never receive traffic.
 *     Pinned immediately so retries and follow-ups are deterministic.
 *  4. Nothing has capacity → SendDeferredError (callers leave work queued).
 */
export function resolveSenderIdentity(to: string, now = new Date()): EmailIdentity {
  const cfg = loadConfig();
  const identities = resolveIdentities(cfg);
  const ledger = getLedger();
  const byId = new Map(identities.map((i) => [i.id, i]));

  const assigned = ledger.getSenderAssignment(to);
  if (assigned) {
    const identity = byId.get(assigned);
    if (!identity) {
      throw new Error(
        `prospect ${to} is pinned to sender identity '${assigned}' which is no longer configured — restore it in emailIdentities or reassign explicitly`,
      );
    }
    return identity;
  }

  if (ledger.hasPriorEmailSend(to)) {
    const legacyId = cfg.emailProvider === "gmail" ? LEGACY_GMAIL_ID : LEGACY_ONESHOT_ID;
    const legacy =
      byId.get(legacyId) ??
      identities.find((i) => i.provider === (cfg.emailProvider === "gmail" ? "gmail" : "oneshot"));
    if (legacy) {
      const winner = ledger.assignSender(to, legacy.id);
      return byId.get(winner) ?? legacy;
    }
    // No identity of the legacy provider left in the pool — fall through to
    // the capacity picker rather than stranding the prospect forever. This
    // DOES switch the thread's From address (the founder removed the
    // original sender), so surface it loudly.
    logEvent(
      "send.legacy_identity_missing",
      { email_domain: to.split("@")[1] ?? "" },
      "warn",
    );
  }

  let best: { identity: EmailIdentity; remaining: number; sent: number } | null = null;
  let overflow: EmailIdentity | null = null;
  for (const identity of identities) {
    const { remaining, sent } = capacityToday(identity, now);
    if (remaining <= 0) continue;
    if (remaining === Infinity) {
      overflow ??= identity;
      continue;
    }
    if (
      !best ||
      remaining > best.remaining ||
      (remaining === best.remaining && sent < best.sent)
    ) {
      best = { identity, remaining, sent };
    }
  }
  const picked = best?.identity ?? overflow;
  if (!picked) {
    throw new SendDeferredError(
      "all sender identities have reached their daily cap — send deferred until tomorrow",
    );
  }
  const winner = ledger.assignSender(to, picked.id);
  return byId.get(winner) ?? picked;
}
