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

/**
 * True when an error is a TRANSIENT platform/transport failure (the OneShot
 * backend or the network briefly broke) rather than a genuine negative result
 * (email not found, undeliverable, no enrichment data). Callers must NOT treat
 * a transient failure as a durable verdict about the candidate: don't drop it,
 * don't negative-cache it, defer/retry instead. Matches the failure shapes seen
 * in the 2026-06 worker outage. Message-based so it works across the SDK's
 * thrown errors, the `withDeadline` rejection, and serialized boundaries.
 *
 * Genuine negatives ("not found", "undeliverable", "no profile data") return
 * false — those ARE durable verdicts and should drop/negative-cache as before.
 */
export function isTransientToolError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("tool execution failed") || // OneShot worker crash (generic)
    msg.includes("timed out") || // job/operation timeout
    msg.includes("timeout") ||
    msg.includes("deadline exceeded") || // withDeadline rejection
    msg.includes("operation timed out") ||
    msg.includes("fetch failed") || // undici/network
    msg.includes("could not fetch") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    // Bare "network" over-matches genuine negatives (e.g. "professional
    // network") — the econn*/fetch-failed/socket checks already cover real
    // network faults; match only explicit network errors.
    /network (error|unreachable|timeout)/.test(msg) ||
    msg.includes("rate limit") || // rate-limited → back off + retry, not a verdict
    /\b(50[0-9]|429)\b/.test(msg) // 5xx / rate-limit HTTP statuses
  );
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

/**
 * The unit that shares one daily ceiling + warm-up ramp. OneShot reputation and
 * the daily send limit are PER-DOMAIN (every mailbox on a domain pools the same
 * reputation), so all oneshot identities with the same sendingDomain share a
 * budget. Gmail accounts are independent — Google warms per-account — so each
 * Gmail identity is its own group keyed by id (this also keeps two Gmail
 * accounts on one Workspace domain from sharing a cap, matching prior behavior).
 */
export function capGroupKey(identity: EmailIdentity): string {
  if (identity.provider === "oneshot") {
    return `domain:${(identity.sendingDomain ?? "__sdk_default__").trim().toLowerCase()}`;
  }
  return `id:${identity.id}`;
}

interface GroupCapacity {
  cap: number;
  sent: number;
  remaining: number;
}

interface PoolCapacity {
  byGroup: Map<string, GroupCapacity>;
  /** identity.id → its cap-group key. */
  groupOf: Map<string, string>;
  /** identity.id → its OWN sends today (0 for uncapped groups unless countUncapped). */
  identitySent: Map<string, number>;
}

/**
 * Aggregate today's capacity for every cap-group in the pool:
 *  - ceiling = MAX member warm-up cap (the domain ramps as one; any uncapped
 *    member ⟹ uncapped group / overflow absorber),
 *  - warm-up anchor = EARLIEST member first-send,
 *  - used = SUM of member sends today.
 * A group with an uncapped member short-circuits to Infinity with NO ledger
 * read on the routing path, so legacy single-identity installs still pay
 * nothing to learn "∞". Display callers pass `countUncapped` to get the real
 * per-identity counts even for uncapped groups.
 */
function computeCapacities(
  identities: EmailIdentity[],
  now = new Date(),
  opts: { countUncapped?: boolean } = {},
): PoolCapacity {
  const members = new Map<string, EmailIdentity[]>();
  const groupOf = new Map<string, string>();
  for (const identity of identities) {
    const key = capGroupKey(identity);
    groupOf.set(identity.id, key);
    let arr = members.get(key);
    if (!arr) {
      arr = [];
      members.set(key, arr);
    }
    arr.push(identity);
  }

  const byGroup = new Map<string, GroupCapacity>();
  const identitySent = new Map<string, number>();
  const todayStart = todayStartSqliteUtc(now);
  for (const [key, group] of members) {
    const uncapped = group.some((i) => i.maxPerDay == null && i.warmup == null);
    if (uncapped && !opts.countUncapped) {
      byGroup.set(key, { cap: Infinity, sent: 0, remaining: Infinity });
      for (const i of group) identitySent.set(i.id, 0);
      continue;
    }
    const ledger = getLedger();
    let firstSendAt: string | null = null;
    let sent = 0;
    for (const i of group) {
      // SQLite "YYYY-MM-DD HH:MM:SS" UTC strings sort lexicographically.
      const first = ledger.firstEmailSendAt(i.id);
      if (first && (firstSendAt == null || first < firstSendAt)) firstSendAt = first;
      const own = ledger.countEmailSendsSince(i.id, todayStart);
      identitySent.set(i.id, own);
      sent += own;
    }
    const cap = uncapped ? Infinity : Math.max(...group.map((i) => warmupCap(i, firstSendAt, now)));
    byGroup.set(key, {
      cap,
      sent,
      remaining: cap === Infinity ? Infinity : Math.max(0, cap - sent),
    });
  }
  return { byGroup, groupOf, identitySent };
}

/** This identity's view of its group's capacity: shared remaining + its own sends (for tie-breaking). */
function capacityFor(
  pool: PoolCapacity,
  identity: EmailIdentity,
): { remaining: number; sent: number } {
  const key = pool.groupOf.get(identity.id) ?? capGroupKey(identity);
  return {
    remaining: pool.byGroup.get(key)?.remaining ?? 0,
    sent: pool.identitySent.get(identity.id) ?? 0,
  };
}

export function remainingToday(identity: EmailIdentity, now = new Date()): number {
  const identities = resolveIdentities(loadConfig());
  const pool = computeCapacities(identities, now);
  if (pool.groupOf.has(identity.id)) return capacityFor(pool, identity).remaining;
  // Identity not in the active pool — evaluate it as its own group.
  return capacityFor(computeCapacities([identity], now), identity).remaining;
}

/** True when at least one cap-group can still send today — lets the cadence engine skip LLM drafting on fully capped days. */
export function hasAnySendCapacity(now = new Date()): boolean {
  const pool = computeCapacities(resolveIdentities(loadConfig()), now);
  for (const g of pool.byGroup.values()) if (g.remaining > 0) return true;
  return false;
}

/** Per-identity capacity for display (setup / doctor / CLI): the shared domain ceiling + both the domain total and this mailbox's own sends today. */
export interface IdentityCapacityView {
  /** Domain (group) ceiling after the ramp; Infinity = uncapped. */
  capToday: number;
  /** Sends across the whole cap-group today (the shared budget used). */
  domainSentToday: number;
  /** This identity's own sends today. */
  identitySentToday: number;
  /** Group remaining today. */
  remaining: number;
}

export function identityCapacities(now = new Date()): Map<string, IdentityCapacityView> {
  const identities = resolveIdentities(loadConfig());
  const pool = computeCapacities(identities, now, { countUncapped: true });
  const out = new Map<string, IdentityCapacityView>();
  for (const identity of identities) {
    const key = pool.groupOf.get(identity.id)!;
    const g = pool.byGroup.get(key)!;
    out.set(identity.id, {
      capToday: g.cap,
      domainSentToday: g.sent,
      identitySentToday: pool.identitySent.get(identity.id) ?? 0,
      remaining: g.remaining,
    });
  }
  return out;
}

/**
 * Which identity sends to this address. Resolution order:
 *  1. Existing sender_assignments pin → that identity (config error if the
 *     id was removed from the pool — never silently re-route a live thread).
 *  2. No pin but the address was emailed pre-rotation → lazy-pin to the
 *     legacy identity (keeps in-flight cadences on their original From).
 *  3. Fresh prospect → CAPPED groups first: most remaining capacity today (the
 *     budget is per cap-group, so all mailboxes on one OneShot domain share it),
 *     tie → fewer sends by that mailbox (spreads traffic across mailboxes in a
 *     domain), then pool order. Uncapped groups are the overflow absorber, used
 *     only when every capped one is full — otherwise an uncapped OneShot domain
 *     would always win on remaining capacity (∞) and the warming Gmail accounts
 *     would never receive traffic. Pinned immediately so retries and follow-ups
 *     are deterministic.
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
    logEvent("send.legacy_identity_missing", { email_domain: to.split("@")[1] ?? "" }, "warn");
  }

  const pool = computeCapacities(identities, now);
  let best: { identity: EmailIdentity; remaining: number; sent: number } | null = null;
  let overflow: EmailIdentity | null = null;
  for (const identity of identities) {
    const { remaining, sent } = capacityFor(pool, identity);
    if (remaining <= 0) continue;
    if (remaining === Infinity) {
      overflow ??= identity;
      continue;
    }
    if (!best || remaining > best.remaining || (remaining === best.remaining && sent < best.sent)) {
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
