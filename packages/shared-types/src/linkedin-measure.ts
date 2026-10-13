/**
 * The LinkedIn funnel (#792): GET /api/measure/linkedin, the `linkedin` block of
 * `oneshot-gtm measure --json`, and the rows of `oneshot-gtm linkedin invites`.
 * Everything is read from the workspace ledger and the synced inbox; nothing
 * here is a platform number.
 */

/**
 * Which kind of invite a unit is. `friend` is the warm connect sent to someone
 * who replied to an email (#791): it never counts as a first touch.
 */
export type LinkedInStepKind = "first-touch" | "continuation" | "friend";

/** The play label every friend invite is recorded under (#791). */
export const LINKEDIN_FRIEND_PLAY = "linkedin:friend";

/** The non-zero step index a friend invite is recorded at, so it is never a first touch. */
export const LINKEDIN_FRIEND_STEP_INDEX = 1;

/** Where a friend invite stands, as shown on the Replies thread. */
export type LinkedInFriendInviteState = "sent" | "accepted" | "withdrawn" | "already_connected";

/** GET /api/prospects/:id/linkedin-friend: whether Connect on LinkedIn is offered, and the invite if one was sent. */
export interface LinkedInFriendView {
  /** True only when the person qualifies and the invite guard passes. */
  canConnect: boolean;
  /** Why not, in words, when `canConnect` is false. */
  reason: string | null;
  invite: { state: LinkedInFriendInviteState; sentAt: string; acceptedAt: string | null } | null;
}

/** POST /api/prospects/:id/linkedin-friend/draft: the note to preview and edit. */
export interface LinkedInFriendDraftView {
  note: string;
  flags: string[];
  /** The hard limit the note is held to. */
  maxChars: number;
}

/** POST /api/prospects/:id/linkedin-friend/send. */
export interface LinkedInFriendSendView {
  ok: true;
  invitationId: string;
  status: string;
}

/**
 * Where an invite stands, as GTM detects it. `already_connected` is an invite
 * LinkedIn answered with "already connected": nobody accepted it, so it is not
 * counted as an acceptance.
 */
export type LinkedInInviteState = "pending" | "accepted" | "withdrawn" | "already_connected";

/** `invitation`: the invite event's `acceptedAt`. `conversation`: a synced 1:1 conversation appeared. */
export type LinkedInAcceptedVia = "invitation" | "conversation";

/** `timeout`: GTM withdrew it after the wait. `manual`: withdrawn by hand (in GTM or on LinkedIn). `unknown`: recorded before the reason was. */
export type LinkedInWithdrawnBy = "timeout" | "manual" | "unknown";

/** Whether the note's prompt carried an evidence clause, as recorded when it was sent. */
export type LinkedInEvidenceVariant = "with" | "without" | "unrecorded";

/** One sent invite: one row of `linkedin invites`. */
export interface LinkedInInviteRow {
  prospectId: number;
  prospect: string | null;
  profile: string | null;
  playName: string;
  /** The cadence step the invite was sent at (0 for a first touch). */
  stepIndex: number;
  stepKind: LinkedInStepKind;
  sentAt: string;
  state: LinkedInInviteState;
  /** Days since it was sent while it is still pending; null otherwise. */
  daysPending: number | null;
  acceptedAt: string | null;
  acceptedVia: LinkedInAcceptedVia | null;
  withdrawnBy: LinkedInWithdrawnBy | null;
  /** The synced conversation with this person, or the one a sent message went into. */
  conversationId: string | null;
  evidence: LinkedInEvidenceVariant;
}

/** A count and its rate over a stated denominator (null when the denominator is 0). */
export interface LinkedInRate {
  count: number;
  of: number;
  rate: number | null;
}

export interface LinkedInFunnel {
  /** Each person once: their newest sent invite. */
  invitesSent: number;
  pending: number;
  withdrawn: { total: number; timeout: number; manual: number; unknown: number };
  accepted: {
    total: number;
    /** By the invite event's `acceptedAt`. */
    viaInvitation: number;
    /** By a synced conversation appearing: the heuristic that misses most accepts. */
    viaConversation: number;
    /** Median days from invite to accept, over the accepts whose time is known. */
    medianDaysToAccept: number | null;
    /** How many accepts the median is over. */
    daysKnown: number;
    /** Accepted over invites sent. */
    rate: number | null;
  };
  /** Invites LinkedIn answered "already connected": not counted as accepted. */
  alreadyConnected: number;
  firstMessageSent: number;
  /** A human reply after the first message and before the next step went out (or with no next step sent). Rate over first messages sent. */
  repliedToFirstMessage: LinkedInRate;
  /** A human reply at any point after the invite. Rate over invites sent. */
  repliedAtAnyPoint: LinkedInRate;
  /** Reply events recorded by two sources that were counted once. */
  repliesMerged: number;
}

export interface LinkedInMeasureFilters {
  sinceDays: number | null;
  play: string | null;
  stepKind: LinkedInStepKind | null;
}

export interface LinkedInMeasureView {
  workspace: string;
  filters: LinkedInMeasureFilters;
  /** Every play with a sent invite in this workspace, for the filter. */
  plays: string[];
  funnel: LinkedInFunnel;
  /** Friend invites (#791) as their own row: they are left out of `funnel` and `variants`. */
  friend: LinkedInFunnel;
  /** The same funnel split by whether the note's prompt carried an evidence clause. */
  variants: {
    withEvidence: LinkedInFunnel;
    withoutEvidence: LinkedInFunnel;
    unrecorded: LinkedInFunnel;
  };
}
