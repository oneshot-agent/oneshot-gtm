import { loadConfig } from "./config.ts";
import { demoMode } from "./demo.ts";
import { logEvent } from "./events.ts";
import { SendDeferredError } from "./send-routing.ts";
import { currentWorkspaceName, getSharedDb } from "./shared-db.ts";

/**
 * This workspace's share of a LinkedIn account's daily invite cap. OneShot
 * caps invites per account (25 per UTC day by default) across every tool
 * using it, and stays authoritative: the share only ever refuses a send
 * earlier, never allows one the account would refuse.
 *
 * `linkedin.invitesPerDay` unset means no share, only the account cap.
 */

/** How long a read of the account's `limits.invites` is reused. */
export const ACCOUNT_LIMITS_TTL_MS = 3 * 60 * 1000;

export interface AccountInviteLimits {
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
}

export type FetchAccount = () => Promise<unknown>;

const limitsCache = new Map<string, { at: number; limits: AccountInviteLimits }>();

/** Test-only: forget cached account limits. */
export function _resetInviteLimitsCacheForTests(): void {
  limitsCache.clear();
}

/** The configured workspace share, or null when unset or invalid. */
export function configuredInvitesPerDay(): number | null {
  const v = loadConfig().linkedin?.invitesPerDay;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseAccountInviteLimits(account: unknown): AccountInviteLimits | null {
  const inv = (account as { limits?: { invites?: Record<string, unknown> } } | null)?.limits
    ?.invites;
  if (!inv || typeof inv !== "object") return null;
  return {
    limit: num(inv["limit"]),
    remaining: num(inv["remaining"]),
    resetsAt: typeof inv["resets_at"] === "string" ? inv["resets_at"] : null,
  };
}

/**
 * The account's invite position, read at most every ACCOUNT_LIMITS_TTL_MS.
 * Null when it can't be read: the server-side cap then decides alone.
 */
export async function accountInviteLimits(
  accountId: string,
  fetchAccount: FetchAccount,
  opts: { force?: boolean; now?: number } = {},
): Promise<AccountInviteLimits | null> {
  const now = opts.now ?? Date.now();
  const hit = limitsCache.get(accountId);
  if (hit && !opts.force && now - hit.at < ACCOUNT_LIMITS_TTL_MS) {
    // Past its reset the cached zero is stale.
    if (!hit.limits.resetsAt || Date.parse(hit.limits.resetsAt) > now) return hit.limits;
  }
  try {
    const limits = parseAccountInviteLimits(await fetchAccount());
    if (limits) limitsCache.set(accountId, { at: now, limits });
    return limits;
  } catch (err) {
    logEvent(
      "linkedin.invite_limits_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/** One invite sent: keep the cached account count honest until the next refresh. */
function noteAccountSend(accountId: string): void {
  const hit = limitsCache.get(accountId);
  if (hit && hit.limits.remaining !== null && hit.limits.remaining > 0) {
    hit.limits = { ...hit.limits, remaining: hit.limits.remaining - 1 };
  }
}

export interface InviteSlot {
  /** The invite was accepted by OneShot. */
  confirm: () => void;
  /** The invite did not go out. */
  release: () => void;
}

/**
 * Take a slot before the API call. Throws SendDeferredError (the row or
 * step stays queued for tomorrow) when the workspace share is used up or the
 * account has no invites left today. Confirm on success, release on failure;
 * an orphaned reservation stops counting after RESERVATION_TTL_MS.
 */
export async function reserveLinkedInInvite(input: {
  accountId: string;
  fetchAccount: FetchAccount;
  workspace?: string;
}): Promise<InviteSlot> {
  const noop: InviteSlot = { confirm: () => {}, release: () => {} };
  if (demoMode()) return noop;
  const perDay = configuredInvitesPerDay();
  const limits = await accountInviteLimits(input.accountId, input.fetchAccount);
  if (limits && limits.remaining !== null && limits.remaining <= 0) {
    throw new SendDeferredError("LinkedIn invites paused for today (account limit reached)");
  }
  const workspace = input.workspace ?? currentWorkspaceName();
  let id: number | null = null;
  try {
    const res = getSharedDb().reserveInviteSlot({
      accountId: input.accountId,
      workspace,
      limit: perDay,
    });
    if ("full" in res) {
      throw new SendDeferredError(
        `LinkedIn invites paused for today (workspace share of ${perDay} used)`,
      );
    }
    id = res.id;
  } catch (err) {
    if (err instanceof SendDeferredError) throw err;
    // The shared file is unavailable: the account cap still holds.
    logEvent(
      "shared_db.write_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return noop;
  }
  const slot = id;
  const settle = (fn: (db: ReturnType<typeof getSharedDb>) => void): void => {
    try {
      fn(getSharedDb());
    } catch (err) {
      logEvent(
        "shared_db.write_failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }
  };
  return {
    confirm: () => {
      settle((db) => db.confirmInviteSlot(slot));
      noteAccountSend(input.accountId);
    },
    release: () => settle((db) => db.releaseInviteSlot(slot)),
  };
}

/** A server-side cap response means the account has nothing left: remember it. */
export function noteAccountInviteCapReached(accountId: string): void {
  const hit = limitsCache.get(accountId);
  limitsCache.set(accountId, {
    at: Date.now(),
    limits: { limit: hit?.limits.limit ?? null, remaining: 0, resetsAt: hit?.limits.resetsAt ?? null },
  });
}

export interface InviteQuotaStatus {
  /** Workspace share per day; null = no share configured. */
  perDay: number | null;
  /** Slots this workspace used today (confirmed + in flight). */
  used: number;
  /** Left of the share today; null when no share. */
  left: number | null;
  /** Left on the account today; null when unknown. */
  accountLeft: number | null;
  accountLimit: number | null;
}

/** Where invites stand today, for /queue, /cadences and Setup. Never throws. */
export async function linkedInInviteStatus(
  accountId: string,
  fetchAccount: FetchAccount,
): Promise<InviteQuotaStatus> {
  const perDay = configuredInvitesPerDay();
  let used = 0;
  try {
    used = getSharedDb().inviteSlotsUsed(
      accountId,
      currentWorkspaceName(),
      new Date().toISOString().slice(0, 10),
    );
  } catch {
    // unreadable: show the account side only
  }
  const limits = await accountInviteLimits(accountId, fetchAccount);
  return {
    perDay,
    used,
    left: perDay === null ? null : Math.max(0, perDay - used),
    accountLeft: limits?.remaining ?? null,
    accountLimit: limits?.limit ?? null,
  };
}

/** "LinkedIn invites today: 4 of 12 left · account 9 left" */
export function describeInviteQuota(s: InviteQuotaStatus): string | null {
  const parts: string[] = [];
  if (s.perDay !== null && s.left !== null) parts.push(`${s.left} of ${s.perDay} left`);
  if (s.accountLeft !== null) parts.push(`account ${s.accountLeft} left`);
  return parts.length ? `LinkedIn invites today: ${parts.join(" · ")}` : null;
}
