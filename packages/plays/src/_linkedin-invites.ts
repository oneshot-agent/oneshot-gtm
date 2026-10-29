import {
  currentWorkspaceName,
  getLedger,
  isWithdrawnStatus,
  KNOWN_CONNECTION_VIA,
  linkedInConversationFor,
  linkedInInviteTimeoutDays,
  linkedInOutreachAccount,
  logEvent,
  sqliteToIso,
  type SequenceEventRecord,
} from "@oneshot-gtm/core";
import type { LinkedInCaller, RunCadenceStepResult } from "./_cadence.ts";

// Where a LinkedIn invite stands, from OneShot's invitation status, and what
// the cadence does about it. Used by the cadence step runner (before a
// LinkedIn message) and by the unattended status sweep (_linkedin-sweep.ts).
// Nothing here drafts or sends a message.

/**
 * Days an unaccepted invite is given before it is withdrawn and the cadence
 * stops, when the workspace sets no `linkedin.inviteTimeoutDays`. A re-export,
 * not a copy, so a test that mocks core whole still loads this file.
 */
export { DEFAULT_LINKEDIN_INVITE_TIMEOUT_DAYS as LINKEDIN_INVITE_TIMEOUT_DAYS } from "@oneshot-gtm/core";
const DAY_MS = 24 * 3600 * 1000;

export type LinkedInInvitationStatus =
  | "pending"
  | "accepted"
  | "withdrawn"
  | "declined_or_unknown"
  | "not_sent";

/** The part of an SDK invitation GTM reads. */
export interface LinkedInInvitationInfo {
  invitationId: string;
  status: LinkedInInvitationStatus;
  acceptedAt: string | null;
}

const STATUSES = new Set<string>([
  "pending",
  "accepted",
  "withdrawn",
  "declined_or_unknown",
  "not_sent",
]);

/** One invitation from the SDK's snake_case shape; null when it isn't one. */
export function parseLinkedInInvitation(raw: unknown): LinkedInInvitationInfo | null {
  const r = raw as {
    invitation_id?: unknown;
    status?: unknown;
    accepted_at?: unknown;
  } | null;
  if (!r || typeof r.invitation_id !== "string" || typeof r.status !== "string") return null;
  if (!STATUSES.has(r.status)) return null;
  return {
    invitationId: r.invitation_id,
    status: r.status as LinkedInInvitationStatus,
    acceptedAt: typeof r.accepted_at === "string" && r.accepted_at ? r.accepted_at : null,
  };
}

/** The `invitations` list result: every entry that parses. */
export function parseLinkedInInvitations(raw: unknown): LinkedInInvitationInfo[] {
  const list = (raw as { invitations?: unknown } | null)?.invitations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((i) => {
    const parsed = parseLinkedInInvitation(i);
    return parsed ? [parsed] : [];
  });
}

export interface LiveLinkedInInvite {
  event: SequenceEventRecord;
  /** A withdrawal was recorded after this invite. */
  withdrawn: boolean;
  invitationId: string | null;
  /** The account that sent it, when the event recorded one. */
  sentBy: { workspace: string; accountId: string } | null;
  /** When the person accepted, once recorded. */
  acceptedAt: string | null;
  /**
   * The invite answered `already_connected`, or no invite was sent because
   * the profile read showed a connection: there is nothing to wait for.
   * False once LinkedIn has said a known connection is not one.
   */
  alreadyConnected: boolean;
  /** Recorded from the profile read in place of an invite (`via: "profile-read"`): no request was sent. */
  knownConnection: boolean;
  /** The last status OneShot reported for it, once read. */
  invitationStatus: string | null;
  /** The invite was closed out (timed out undeclared, or its cadence ended): nothing left to poll. */
  endedAt: string | null;
  invitedAtMs: number;
  /** The queue row that sent it; null for a continuation or friend invite, or one recorded before rows were. */
  queueId: number | null;
  /** When an unattended withdrawal last failed, so the sweep waits a day before trying again. */
  lastWithdrawAttemptAt: string | null;
}

function parseMeta(json: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The newest sent invite for a prospect and play: an earlier one may have
 * been withdrawn by hand and the person invited again.
 */
export function liveLinkedInInvite(
  prospectId: number,
  playName: string,
): LiveLinkedInInvite | null {
  return liveInviteFromEvents(getLedger().listLinkedInInviteEvents(prospectId, playName));
}

/** The live invite from one prospect and play's invite events, oldest first: see liveLinkedInInvite. */
export function liveInviteFromEvents(events: SequenceEventRecord[]): LiveLinkedInInvite | null {
  const at = events.findLastIndex((e) => e.status === "sent");
  const event = at >= 0 ? events[at] : undefined;
  if (!event) return null;
  const meta = parseMeta(event.metadata_json);
  const accountId = str(meta.accountId);
  const accountWorkspace = str(meta.accountWorkspace);
  const withdrawn = events.slice(at + 1).some((e) => e.status === "withdrawn");
  const knownConnection = meta.via === KNOWN_CONNECTION_VIA;
  return {
    event,
    withdrawn,
    invitationId: str(meta.invitationId),
    sentBy: accountId && accountWorkspace ? { workspace: accountWorkspace, accountId } : null,
    acceptedAt: str(meta.acceptedAt),
    alreadyConnected: meta.inviteStatus === "already_connected" && !(knownConnection && withdrawn),
    knownConnection,
    invitationStatus: str(meta.invitationStatus),
    endedAt: str(meta.endedAt),
    invitedAtMs: Date.parse(sqliteToIso(event.created_at)),
    queueId: typeof meta.queueId === "number" ? meta.queueId : null,
    lastWithdrawAttemptAt: str(meta.lastWithdrawAttemptAt),
  };
}

/** Whether the invite is known to be accepted without asking anyone. */
export function inviteKnownAccepted(invite: LiveLinkedInInvite | null): boolean {
  return Boolean(invite && (invite.acceptedAt || invite.alreadyConnected));
}

/** The account a message to this prospect goes out from. */
export function linkedInSenderFor(
  prospectId: number,
  playName: string,
): { workspace: string; accountId: string } | null {
  return liveLinkedInInvite(prospectId, playName)?.sentBy ?? linkedInOutreachAccount();
}

/**
 * The conversation an earlier message of this cadence went into, as the send
 * stored it. A first message to a connection with no conversation creates
 * one before the inbox has synced it; the close goes into the same one.
 */
export function storedLinkedInConversation(
  prospectId: number,
  playName: string,
): { conversationId: string; accountId: string; workspace: string } | null {
  const sent = getLedger()
    .listSequenceEventsForProspectPlay(prospectId, playName)
    .filter((e) => e.channel === "linkedin" && e.status === "sent");
  for (const e of sent.toReversed()) {
    const meta = parseMeta(e.metadata_json);
    const conversationId = str(meta.conversationId);
    const accountId = str(meta.accountId);
    const workspace = str(meta.accountWorkspace);
    if (conversationId && accountId && workspace) return { conversationId, accountId, workspace };
  }
  return null;
}

/** Whether a LinkedIn message may go out: accepted (recorded), already connected, or a conversation exists. */
export function linkedInAcceptedLocally(input: {
  prospectId: number;
  playName: string;
  prospectLinkedinUrl: string | null;
}): boolean {
  if (inviteKnownAccepted(liveLinkedInInvite(input.prospectId, input.playName))) return true;
  return Boolean(
    linkedInConversationFor({
      workspace: currentWorkspaceName(),
      prospectId: input.prospectId,
      linkedinUrl: input.prospectLinkedinUrl,
    }) || storedLinkedInConversation(input.prospectId, input.playName),
  );
}

/**
 * Null when a LinkedIn message may be drafted (the invite is recorded as
 * accepted, or a conversation exists), or when nothing was sent to wait on (a
 * known connection LinkedIn said is not one: the request is drafted next);
 * otherwise the date the wait began. Reads local state only: the unattended
 * status sweep records acceptances.
 */
export function linkedInWaitingSince(input: {
  prospectId: number;
  playName: string;
  prospectLinkedinUrl: string | null;
}): string | null {
  if (linkedInAcceptedLocally(input)) return null;
  const invite = liveLinkedInInvite(input.prospectId, input.playName);
  if (invite?.knownConnection && invite.withdrawn) return null;
  const at = invite && Number.isFinite(invite.invitedAtMs) ? invite.invitedAtMs : Date.now();
  return new Date(at).toISOString().slice(0, 10);
}

async function fetchInvitation(
  linkedIn: LinkedInCaller | undefined,
  invite: LiveLinkedInInvite | null,
  account: { workspace: string; accountId: string } | null,
): Promise<LinkedInInvitationInfo | null> {
  if (!linkedIn || !invite?.invitationId || !account) return null;
  try {
    return parseLinkedInInvitation(
      await linkedIn(account.workspace, {
        kind: "invitation",
        accountId: account.accountId,
        invitationId: invite.invitationId,
      }),
    );
  } catch (err) {
    logEvent(
      "cadence.linkedin_invitation_status_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

export type InviteResolution =
  | { state: "accepted" }
  /** No status could be read (sweep mode only). */
  | { state: "unknown" }
  /** `withdrewNow`: this call withdrew the invite at the timeout. */
  | { state: "result"; result: RunCadenceStepResult; withdrewNow?: boolean };

export interface ResolveInviteInput {
  prospectId: number;
  playName: string;
  prospectLinkedinUrl: string | null;
  linkedIn?: LinkedInCaller | undefined;
  dryRun: boolean;
  /**
   * cadence: the step runner, which postpones a waiting step a day and falls
   * back to the conversation check when no status is available.
   * sweep: the unattended status sweep, which changes nothing it can't see.
   */
  mode: "cadence" | "sweep";
  /** A status the caller already holds; undefined asks for it. */
  invitation?: LinkedInInvitationInfo | null;
}

/**
 * Has this prospect's newest invite been accepted? Asks OneShot for the
 * invitation's status first:
 *  - accepted: records `acceptedAt` on the invite event and goes ahead;
 *  - pending: waits, and withdraws the invite at the timeout;
 *  - withdrawn: the invite is gone, so the cadence ends;
 *  - declined_or_unknown: waits to the timeout, then ends without a withdraw;
 *  - not_sent: marks the invite event failed, so it never counts as an invite.
 * With no invitation id, no caller or a failed call, the cadence falls back to
 * "a synced conversation with them exists".
 */
export async function resolveLinkedInInvite(input: ResolveInviteInput): Promise<InviteResolution> {
  const ledger = getLedger();
  const invite = liveLinkedInInvite(input.prospectId, input.playName);
  if (inviteKnownAccepted(invite)) return { state: "accepted" };
  const account = invite?.sentBy ?? linkedInOutreachAccount();
  const info =
    input.invitation !== undefined
      ? input.invitation
      : await fetchInvitation(input.linkedIn, invite, account);

  const ends = (note: string): InviteResolution => {
    if (input.dryRun) {
      return {
        state: "result",
        result: { action: "skipped", payload: null, receiptIds: [], note: `${note} — would stop` },
      };
    }
    // In cadence mode the caller is the send worker, which claimed the
    // sending marker before this ran; a plain stop is refused under it.
    endInvite(input, invite, note);
    return {
      state: "result",
      result: { action: "completed", payload: null, receiptIds: [], note },
    };
  };

  if (info && invite) {
    if (info.status === "accepted") {
      if (!input.dryRun) {
        ledger.updateLinkedInInviteEvent({
          id: invite.event.id,
          metadata: {
            acceptedAt: info.acceptedAt ?? new Date().toISOString(),
            invitationStatus: "accepted",
          },
        });
      }
      return { state: "accepted" };
    }
    if (info.status === "withdrawn") {
      if (!invite.withdrawn && !input.dryRun) {
        ledger.recordLinkedInInviteEvent({
          prospectId: input.prospectId,
          playName: input.playName,
          stepIndex: invite.event.step_index,
          status: "withdrawn",
          metadata: {
            invitationId: info.invitationId,
            withdrawStatus: "withdrawn",
            withdrawnBy: "manual",
          },
        });
      }
      return ends("LinkedIn invite was withdrawn");
    }
    if (info.status === "not_sent") {
      if (!input.dryRun) {
        ledger.updateLinkedInInviteEvent({
          id: invite.event.id,
          status: "failed",
          metadata: { failureReason: "not_sent", invitationStatus: "not_sent" },
        });
      }
      return ends("LinkedIn invite was never sent (not_sent)");
    }
    const pending = info.status === "pending";
    if (!pending && !input.dryRun && invite.invitationStatus !== info.status) {
      // Remembered, so the sweep never withdraws an invite OneShot calls declined.
      ledger.updateLinkedInInviteEvent({
        id: invite.event.id,
        metadata: { invitationStatus: info.status },
      });
    }
    return waitOrTimeOut(input, invite, account, pending);
  }

  if (input.mode === "sweep") return { state: "unknown" };
  if (
    linkedInConversationFor({
      workspace: currentWorkspaceName(),
      prospectId: input.prospectId,
      linkedinUrl: input.prospectLinkedinUrl,
    }) ||
    storedLinkedInConversation(input.prospectId, input.playName)
  ) {
    return { state: "accepted" };
  }
  return waitOrTimeOut(input, invite, account, true);
}

/**
 * Ends the invite's cadence and closes the invite out. A friend invite (#791)
 * has no cadence row, so stopping does nothing for it: the `endedAt` mark is
 * what takes it off the unattended sweep's list.
 */
function endInvite(
  input: ResolveInviteInput,
  invite: LiveLinkedInInvite | null,
  note: string,
): void {
  endLinkedInInvite({
    prospectId: input.prospectId,
    playName: input.playName,
    invite,
    note,
    holdingSendingMarker: input.mode === "cadence",
  });
}

/**
 * Stops the cadence and marks the invite ended. False when the cadence was
 * not stopped: none is active, or a send holds it and the caller does not.
 * The invite is marked ended either way.
 */
export function endLinkedInInvite(input: {
  prospectId: number;
  playName: string;
  invite: LiveLinkedInInvite | null;
  note: string;
  holdingSendingMarker: boolean;
}): boolean {
  const ledger = getLedger();
  const stopped = ledger.stopCadence({
    prospectId: input.prospectId,
    playName: input.playName,
    reason: "other",
    note: input.note,
    holdingSendingMarker: input.holdingSendingMarker,
  });
  if (input.invite && !input.invite.endedAt) {
    ledger.updateLinkedInInviteEvent({
      id: input.invite.event.id,
      metadata: { endedAt: new Date().toISOString(), endedNote: input.note },
    });
  }
  return stopped;
}

/**
 * Not accepted yet: wait a day, or, past linkedInInviteTimeoutDays(), end the
 * invite: withdrawn when it is still pending, left alone when OneShot says it
 * was declined or has no status.
 */
async function waitOrTimeOut(
  input: ResolveInviteInput,
  invite: LiveLinkedInInvite | null,
  account: { workspace: string; accountId: string } | null,
  withdraw: boolean,
): Promise<InviteResolution> {
  const ledger = getLedger();
  const days = (Date.now() - (invite ? invite.invitedAtMs : Date.now())) / DAY_MS;
  const timeoutDays = linkedInInviteTimeoutDays();
  if (days < timeoutDays) {
    if (input.mode === "cadence" && !input.dryRun) {
      ledger.postponeCadence({
        prospectId: input.prospectId,
        playName: input.playName,
        nextDueAt: new Date(Date.now() + DAY_MS).toISOString(),
      });
    }
    return {
      state: "result",
      result: {
        action: "waiting",
        payload: null,
        receiptIds: [],
        note: "waiting for the LinkedIn invite to be accepted",
      },
    };
  }
  const note = `LinkedIn invite not accepted after ${timeoutDays} days`;
  if (input.dryRun) {
    return {
      state: "result",
      result: {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: `${note} — would ${withdraw ? "withdraw" : "stop"}`,
      },
    };
  }
  let withdrawStatus: string | null = null;
  if (withdraw && invite?.invitationId && account && input.linkedIn) {
    try {
      const res = (await input.linkedIn(account.workspace, {
        kind: "withdraw",
        accountId: account.accountId,
        invitationId: invite.invitationId,
        idempotencyKey: `gtm:${currentWorkspaceName()}:cadence:${input.prospectId}:${input.playName}:withdraw:${invite.invitationId}`,
        playName: input.playName,
      })) as { status?: string };
      withdrawStatus = res.status ?? null;
      if (withdrawStatus === "not_pending") {
        // Accepted, or gone some other way: nothing was withdrawn, and the
        // status read that led here may have missed an acceptance. Re-read it
        // before ending anything.
        if (input.mode === "cadence") {
          ledger.postponeCadence({
            prospectId: input.prospectId,
            playName: input.playName,
            nextDueAt: new Date(Date.now() + DAY_MS).toISOString(),
          });
        }
        return {
          state: "result",
          result: {
            action: "waiting",
            payload: null,
            receiptIds: [],
            note: `${note} — invite no longer pending, re-checking its status`,
          },
        };
      }
      if (isWithdrawnStatus(withdrawStatus)) {
        // On the invite's own step: a continuation invite is not step 0.
        ledger.recordLinkedInInviteEvent({
          prospectId: input.prospectId,
          playName: input.playName,
          stepIndex: invite.event.step_index,
          status: "withdrawn",
          metadata: { invitationId: invite.invitationId, withdrawStatus, withdrawnBy: "timeout" },
        });
      }
    } catch (err) {
      logEvent(
        "cadence.linkedin_withdraw_failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      // Leave the invite's cadence running and try again in a day: stopping
      // here would strand the invite pending with nothing to retry it. The
      // attempt is recorded so the sweep waits the day too.
      const prior = parseMeta(invite.event.metadata_json);
      const attempts = typeof prior.withdrawAttempts === "number" ? prior.withdrawAttempts : 0;
      ledger.updateLinkedInInviteEvent({
        id: invite.event.id,
        metadata: {
          lastWithdrawAttemptAt: new Date().toISOString(),
          withdrawAttempts: attempts + 1,
        },
      });
      if (input.mode === "cadence") {
        ledger.postponeCadence({
          prospectId: input.prospectId,
          playName: input.playName,
          nextDueAt: new Date(Date.now() + DAY_MS).toISOString(),
        });
      }
      return {
        state: "result",
        result: {
          action: "waiting",
          payload: null,
          receiptIds: [],
          note: `${note} — withdraw failed, retrying in a day`,
        },
      };
    }
  }
  endInvite(input, invite, note);
  return {
    state: "result",
    withdrewNow: isWithdrawnStatus(withdrawStatus),
    result: {
      action: "completed",
      payload: null,
      receiptIds: [],
      note: withdrawStatus
        ? `${note} — invite ${withdrawStatus}`
        : !withdraw
          ? note
          : invite?.invitationId
            ? `${note} — withdraw it from /queue`
            : `${note} — no invitation id recorded; withdraw it on LinkedIn`,
    },
  };
}
