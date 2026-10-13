import { getLedger, linkedInOutreachAccount, logEvent } from "@oneshot-gtm/core";
import type { LinkedInCaller } from "./_cadence.ts";
import {
  LINKEDIN_INVITE_TIMEOUT_DAYS,
  liveLinkedInInvite,
  parseLinkedInInvitations,
  resolveLinkedInInvite,
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
}

const watermarkKey = (a: { workspace: string; accountId: string }): string =>
  `linkedin.invitations.since:${a.workspace}:${a.accountId}`;

/**
 * The unattended half of the LinkedIn cadence: reads invitation statuses and
 * withdraws invites that outlived LINKEDIN_INVITE_TIMEOUT_DAYS. It records
 * acceptances (`acceptedAt`) and nothing else a person would see. It never
 * drafts and never sends a message: the first message appears on /cadences
 * as due, like any follow-up, to be reviewed and sent there.
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
  };
  const nowMs = (input.now ?? new Date()).getTime();

  // Pending invites, grouped by the account that sent them.
  const byAccount = new Map<
    string,
    {
      account: { workspace: string; accountId: string };
      items: Array<{ prospectId: number; playName: string; invite: LiveLinkedInInvite }>;
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
    group.items.push({ prospectId: c.prospect_id, playName: c.play_name, invite });
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
      const overdue = nowMs - item.invite.invitedAtMs >= LINKEDIN_INVITE_TIMEOUT_DAYS * DAY_MS;
      if (!invitation && !overdue && !truncated) continue;
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
      else if (resolution.state === "result") {
        const note = resolution.result.note ?? "";
        if (resolution.result.action === "completed") {
          out.stopped++;
          if (/withdrawn/i.test(note)) out.withdrawn++;
        }
      }
    }
    // Only a list we actually read, with every invite beyond a full page read
    // one by one, moves the watermark; otherwise the same window is retried.
    if (listed && !unread) ledger.setPollWatermark(watermarkKey(account), startedAt);
  }
  if (out.accepted + out.stopped > 0) logEvent("linkedin.invitation_sweep", { ...out });
  return out;
}
