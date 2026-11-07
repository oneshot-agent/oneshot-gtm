import {
  getLedger,
  linkedInInviteExpiryDays,
  linkedInInviteTimeoutDays,
  linkedInOutreachAccount,
  logEvent,
} from "@oneshot-gtm/core";
import type { LinkedInCaller } from "./_cadence.ts";
import { sweepLinkedInPendingSends, type LinkedInPendingSweepResult } from "./_linkedin-pending.ts";
import {
  liveLinkedInInvite,
  parseLinkedInInvitations,
  resolveLinkedInInvite,
  withdrawInviteForOptOut,
  type LinkedInInvitationInfo,
  type LiveLinkedInInvite,
} from "./_linkedin-invites.ts";

/** Most invitations one status call returns (the API's ceiling). */
const INVITATIONS_PAGE = 100;
const DAY_MS = 24 * 3600 * 1000;
/** Re-read a margin before the last good look to tolerate clock skew. */
const WATERMARK_OVERLAP_MS = 60 * 60_000;

export interface LinkedInInviteSweepResult {
  /** Invites still waiting on an answer when the sweep began. */
  pending: number;
  /** Status calls made (one list per account, plus one per overdue invite not in it). */
  calls: number;
  accepted: number;
  withdrawn: number;
  stopped: number;
  /** Of `withdrawn`, invites withdrawn at once because the person opted out. */
  optedOut: number;
  /** Messages and invites whose outcome was pending, resolved first. */
  pendingSends: LinkedInPendingSweepResult;
}

const watermarkKey = (a: { workspace: string; accountId: string }): string =>
  `linkedin.invitations.since:${a.workspace}:${a.accountId}`;

/**
 * The unattended half of the LinkedIn cadence: reads invitation statuses and
 * withdraws invites that outlived linkedInInviteTimeoutDays(). It records
 * acceptances (`acceptedAt`) and nothing else a person would see. It never
 * drafts and never sends a message: the first message appears on /cadences
 * as due, like any follow-up, to be reviewed and sent there. First it
 * records the outcome of sends that were still pending (_linkedin-pending.ts),
 * which only reads OneShot's records.
 *
 * It watches every pending invite whatever its cadence's status, so one whose
 * cadence a reply or a stop ended is still recorded when accepted and still
 * withdrawn at the timeout. The invite of someone who opted out is withdrawn
 * at once.
 */
export async function sweepLinkedInInvitations(input: {
  linkedIn: LinkedInCaller;
  now?: Date;
}): Promise<LinkedInInviteSweepResult> {
  const ledger = getLedger();
  const out: LinkedInInviteSweepResult = {
    pending: 0,
    calls: 0,
    accepted: 0,
    withdrawn: 0,
    stopped: 0,
    optedOut: 0,
    pendingSends: await sweepLinkedInPendingSends({ linkedIn: input.linkedIn }),
  };
  const nowMs = (input.now ?? new Date()).getTime();
  const timeoutMs = linkedInInviteTimeoutDays() * DAY_MS;

  // Pending invites, grouped by the account that sent them.
  const byAccount = new Map<
    string,
    {
      account: { workspace: string; accountId: string };
      items: Array<{
        prospectId: number;
        playName: string;
        invite: LiveLinkedInInvite;
        optedOut: boolean;
      }>;
    }
  >();
  const fallback = linkedInOutreachAccount();
  for (const c of ledger.listLinkedInInviteCadences()) {
    const invite = liveLinkedInInvite(c.prospect_id, c.play_name);
    if (!invite || invite.withdrawn || !invite.invitationId) continue;
    if (invite.acceptedAt || invite.alreadyConnected || invite.endedAt) continue;
    const account = invite.sentBy ?? fallback;
    if (!account) continue;
    const key = `${account.workspace}\u0000${account.accountId}`;
    const group = byAccount.get(key) ?? { account, items: [] };
    group.items.push({
      prospectId: c.prospect_id,
      playName: c.play_name,
      invite,
      optedOut: c.opted_out === 1,
    });
    byAccount.set(key, group);
    out.pending++;
  }
  if (out.pending === 0) return out;

  for (const { account, items } of byAccount.values()) {
    // Free read: only what changed since the last good look at this account.
    const since = ledger.getPollWatermark(watermarkKey(account));
    const startedAt = new Date(nowMs - WATERMARK_OVERLAP_MS).toISOString();
    const changed = new Map<string, LinkedInInvitationInfo>();
    let listed = false;
    let truncated = false;
    let unread = false;
    try {
      out.calls++;
      const res = await input.linkedIn(account.workspace, {
        kind: "invitations",
        accountId: account.accountId,
        ...(since ? { changedSince: since } : {}),
        limit: INVITATIONS_PAGE,
      });
      for (const i of parseLinkedInInvitations(res)) changed.set(i.invitationId, i);
      // The API has no cursor: a full page may hide more changes behind it.
      const rawCount = (res as { invitations?: unknown } | null)?.invitations;
      truncated = Array.isArray(rawCount) && rawCount.length >= INVITATIONS_PAGE;
      listed = true;
    } catch (err) {
      logEvent(
        "linkedin.invitation_sweep.list_failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }

    for (const item of items) {
      const id = item.invite.invitationId!;
      const invitation = changed.get(id);
      const lastTry = Date.parse(item.invite.lastWithdrawAttemptAt ?? "");
      // They opted out: withdraw now, unless the list already shows the
      // invite answered (then it is recorded as usual below). A failed try
      // waits a day like any other.
      if (item.optedOut && (!invitation || invitation.status === "pending")) {
        if (nowMs - lastTry < DAY_MS) continue;
        out.calls++;
        const outcome = await withdrawInviteForOptOut({
          prospectId: item.prospectId,
          playName: item.playName,
          invite: item.invite,
          account,
          linkedIn: input.linkedIn,
        });
        if (outcome !== "failed") out.stopped++;
        if (outcome === "withdrawn") {
          out.withdrawn++;
          out.optedOut++;
        }
        continue;
      }
      const overdue = nowMs - item.invite.invitedAtMs >= timeoutMs;
      if (!invitation && !overdue && !truncated) continue;
      // A withdrawal that failed waits a day before the next try, unless the
      // invitation changed since. The retry reads its status first, so an
      // accept hidden past a full page is still caught then.
      if (!invitation && nowMs - lastTry < DAY_MS) continue;
      // Overdue, or the list was a full page: the resolver asks for that one
      // invitation (before withdrawing anything), so neither an accept past
      // the page nor one that slipped past the watermark is skipped.
      if (!invitation) out.calls++;
      const resolution = await resolveLinkedInInvite({
        prospectId: item.prospectId,
        playName: item.playName,
        prospectLinkedinUrl: null,
        linkedIn: input.linkedIn,
        dryRun: false,
        mode: "sweep",
        ...(invitation ? { invitation } : {}),
      });
      if (resolution.state === "unknown") unread = true;
      if (resolution.state === "accepted") out.accepted++;
      else if (resolution.state === "result" && resolution.result.action === "completed") {
        out.stopped++;
        if (resolution.withdrewNow) out.withdrawn++;
      }
    }
    // Only a list we actually read, with every invite beyond a full page read
    // one by one, moves the watermark; otherwise the same window is retried.
    if (listed && !unread) ledger.setPollWatermark(watermarkKey(account), startedAt);
  }
  if (out.accepted + out.stopped > 0)
    logEvent("linkedin.invitation_sweep", {
      pending: out.pending,
      calls: out.calls,
      accepted: out.accepted,
      withdrawn: out.withdrawn,
      stopped: out.stopped,
      opted_out: out.optedOut,
    });
  return out;
}

/**
 * With `linkedin.inviteExpiryDays` set, completes every cadence whose
 * connection request has been due and unsent for longer than that, with stop
 * reason `invite_expired`: a request the invite share held back that long is
 * dropped, not sent late. Local only (one ledger statement, no LinkedIn
 * call). Unset: does nothing. Returns how many cadences it completed.
 */
export function expireUnsentLinkedInInvites(input: { now?: Date } = {}): number {
  const days = linkedInInviteExpiryDays();
  if (days === null) return 0;
  const now = input.now ?? new Date();
  const expired = getLedger().expireUnsentLinkedInInvites({
    before: new Date(now.getTime() - days * DAY_MS),
    note: `connection request still unsent ${days} days after it was due`,
  });
  if (expired.length > 0) logEvent("linkedin.invite_expiry", { expired: expired.length, days });
  return expired.length;
}
