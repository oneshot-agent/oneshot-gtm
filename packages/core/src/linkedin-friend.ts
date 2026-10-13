import {
  LINKEDIN_FRIEND_PLAY,
  type LinkedInFriendInviteState,
  type LinkedInFriendView,
} from "@oneshot-gtm/shared-types";
import { getLedger } from "./ledger.ts";
import {
  canInviteOnLinkedIn,
  type LinkedInGuardContext,
  type LinkedInGuardLedger,
  type LinkedInGuardReason,
} from "./linkedin-guard.ts";
import { linkedInHasConversationWith } from "./linkedin-inbox.ts";
import type { InboxReplyRecord, ProspectRecord, SequenceEventRecord } from "./types.ts";

/**
 * The warm LinkedIn connect (#791): a connection request to someone who
 * replied positively to an email, with a short note and no messages after it.
 * Who qualifies is an allow-list that fails closed: a reply the classifier is
 * sure about and calls positive, and no reply anywhere that vetoes it.
 */

/** A human reply with one of these labels (and no review flag) qualifies. */
export const FRIEND_INTENTS: readonly string[] = [
  "interested",
  "question",
  "partnership",
  "meeting",
];

/** One reply with any of these labels disqualifies the person, whatever else they wrote. */
export const FRIEND_VETO_INTENTS: readonly string[] = [
  "unsubscribe",
  "wrong_person",
  "complaint",
  "not_interested",
  "objection",
  "pitch_back",
];

export type FriendReplyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Do these replies, from one person, qualify for a friend connect? A label
 * that is missing (untriaged), flagged for review (low confidence) or not on
 * the list never qualifies. A veto label on any reply, of any kind, refuses.
 */
export function friendReplyVerdict(
  replies: ReadonlyArray<Pick<InboxReplyRecord, "kind" | "intent" | "intent_review">>,
): FriendReplyVerdict {
  const veto = replies.find(
    (r) => r.kind === "unsubscribe" || (r.intent != null && FRIEND_VETO_INTENTS.includes(r.intent)),
  );
  if (veto) return { ok: false, reason: `they replied "${veto.intent ?? veto.kind}"` };
  const positive = replies.some(
    (r) =>
      (r.kind ?? "human") === "human" &&
      r.intent != null &&
      FRIEND_INTENTS.includes(r.intent) &&
      r.intent_review === 0,
  );
  return positive
    ? { ok: true }
    : { ok: false, reason: "no confidently labelled positive email reply" };
}

/** What the friend check reads from the ledger. `Ledger` satisfies it. */
export interface LinkedInFriendLedger extends LinkedInGuardLedger {
  getProspectById(id: number): ProspectRecord | null;
  listInboxRepliesForProspect(prospectId: number): InboxReplyRecord[];
  listLinkedInInviteEvents(prospectId: number, playName: string): SequenceEventRecord[];
}

export interface LinkedInFriendContext extends Omit<LinkedInGuardContext, "ledger"> {
  ledger: LinkedInFriendLedger;
}

export type FriendVerdict =
  | { ok: true; prospect: ProspectRecord }
  | { ok: false; reason: string; guard?: LinkedInGuardReason };

/** Whether a prospect may be offered Connect on LinkedIn: the reply allow-list, then the invite guard. */
export function canConnectAsFriend(prospectId: number, ctx: LinkedInFriendContext): FriendVerdict {
  const prospect = ctx.ledger.getProspectById(prospectId);
  if (!prospect) return { ok: false, reason: "prospect not found" };
  const replies = friendReplyVerdict(ctx.ledger.listInboxRepliesForProspect(prospectId));
  if (!replies.ok) return replies;
  const verdict = canInviteOnLinkedIn(
    {
      prospectId,
      name: prospect.name,
      company: prospect.company,
      email: prospect.email,
      linkedinUrl: prospect.linkedin_url,
      friend: true,
    },
    ctx,
  );
  if (!verdict.ok) return { ok: false, reason: verdict.detail, guard: verdict.reason };
  return { ok: true, prospect };
}

/** `canConnectAsFriend` against the process-wide ledger and synced inbox. */
export function canConnectAsFriendNow(prospectId: number): FriendVerdict {
  return canConnectAsFriend(prospectId, {
    ledger: getLedger(),
    inbox: { hasConversationWith: (url) => linkedInHasConversationWith(url) },
  });
}

function metaOf(event: SequenceEventRecord): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.metadata_json ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The newest friend invite sent to this prospect and where it stands, or null when none went out. */
export function friendInviteOf(
  prospectId: number,
  ctx: Pick<LinkedInFriendContext, "ledger" | "inbox">,
): NonNullable<LinkedInFriendView["invite"]> | null {
  const events = ctx.ledger.listLinkedInInviteEvents(prospectId, LINKEDIN_FRIEND_PLAY);
  const at = events.findLastIndex((e) => e.status === "sent");
  const sent = at >= 0 ? events[at] : undefined;
  if (!sent) return null;
  const meta = metaOf(sent);
  const acceptedAt = typeof meta["acceptedAt"] === "string" ? meta["acceptedAt"] : null;
  const withdrawn = events.slice(at + 1).some((e) => e.status === "withdrawn");
  let state: LinkedInFriendInviteState;
  if (acceptedAt || meta["invitationStatus"] === "accepted") state = "accepted";
  else if (withdrawn) state = "withdrawn";
  else if (meta["inviteStatus"] === "already_connected") state = "already_connected";
  else {
    const url = ctx.ledger.getProspectById(prospectId)?.linkedin_url;
    let talking = false;
    try {
      talking = url ? ctx.inbox.hasConversationWith(url) : false;
    } catch {
      talking = false;
    }
    state = talking ? "accepted" : "sent";
  }
  return {
    state,
    sentAt: new Date(
      `${sent.created_at.replace(" ", "T")}${sent.created_at.includes("Z") ? "" : "Z"}`,
    ).toISOString(),
    acceptedAt,
  };
}

/**
 * What Replies shows for a prospect's thread: the invite's state when one
 * went out, otherwise whether Connect on LinkedIn is offered. The cheap reply
 * check runs first, so the guard only reads the shared DB and the inbox for
 * people who already qualify.
 */
export function linkedInFriendView(
  prospectId: number,
  ctx: LinkedInFriendContext,
): LinkedInFriendView {
  const invite = friendInviteOf(prospectId, ctx);
  if (invite) return { canConnect: false, reason: "already invited", invite };
  const verdict = canConnectAsFriend(prospectId, ctx);
  return verdict.ok
    ? { canConnect: true, reason: null, invite: null }
    : { canConnect: false, reason: verdict.reason, invite: null };
}

export function linkedInFriendViewNow(prospectId: number): LinkedInFriendView {
  return linkedInFriendView(prospectId, {
    ledger: getLedger(),
    inbox: { hasConversationWith: (url) => linkedInHasConversationWith(url) },
  });
}
