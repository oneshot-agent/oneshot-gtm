import {
  currentWorkspaceName,
  getLedger,
  isFirstDegree,
  logEvent,
  normalizeLinkedInProfile,
  releaseKnownConnection,
} from "@oneshot-gtm/core";
import { storedNetworkDistance } from "./_linkedin-evidence.ts";
import type { LiveLinkedInInvite } from "./_linkedin-invites.ts";

/**
 * People already connected to the outreach account get no connection request:
 * the profile read GTM already made says so (`network_distance`), and the
 * first LinkedIn message comes next. Only a recent stored read counts; nothing
 * here calls LinkedIn.
 */

/** How old a profile read may be and still say who is connected. */
export const KNOWN_CONNECTION_MAX_AGE_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;

/** Subject of the draft and of the event recorded in place of an invite. */
export const KNOWN_CONNECTION_SUBJECT = "LinkedIn: already connected";

export interface KnownConnection {
  /** When the profile read that showed the connection was made. */
  readAt: string;
}

/**
 * The person at this profile is a first-degree connection, as the newest
 * stored profile read that reports a distance says, read at most
 * KNOWN_CONNECTION_MAX_AGE_DAYS ago. Null for anything else: no read, an
 * older one, another distance, or a read that does not report one.
 */
export function knownConnection(
  linkedinUrl: string | null | undefined,
  now: Date = new Date(),
): KnownConnection | null {
  const profile = normalizeLinkedInProfile(linkedinUrl);
  if (!profile) return null;
  try {
    const read = storedNetworkDistance(profile.url, {
      now,
      maxAgeMs: KNOWN_CONNECTION_MAX_AGE_DAYS * DAY_MS,
    });
    return read && isFirstDegree(read.distance) ? { readAt: read.readAt } : null;
  } catch {
    return null;
  }
}

/** The read's date, YYYY-MM-DD. */
export function knownConnectionDay(connection: KnownConnection): string {
  return connection.readAt.slice(0, 10);
}

/** What /queue shows for a known connection's row in place of a note. Nothing in it is sent. */
export function knownConnectionDraft(connection: KnownConnection): {
  subject: string;
  body: string;
  flags: string[];
  knownConnection: KnownConnection;
} {
  return {
    subject: KNOWN_CONNECTION_SUBJECT,
    body: `Already connected (profile read ${knownConnectionDay(connection)}): no connection request. The first message comes up on /cadences.`,
    flags: [],
    knownConnection: connection,
  };
}

/** A known connection recorded in place of an invite, that LinkedIn has since said is not one. */
export function connectionVoided(invite: LiveLinkedInInvite | null): boolean {
  return Boolean(invite?.knownConnection && invite.withdrawn);
}

/**
 * A message to a known connection came back `not_connected`: the profile read
 * was wrong or the connection is gone. The record that stood in for the
 * invite is withdrawn, so nothing reads them as connected any more, and its
 * claim on the profile is freed, so the connection request that replaces it
 * can be drafted, reviewed and sent at the cadence's current step.
 *
 * The claim is freed first: a withdrawal recorded over a claim still held
 * would leave a request the guard refuses for good. Throws, recording
 * nothing, when the shared file can't be written; the step stays due and the
 * next send tries again.
 */
export function voidKnownConnection(input: {
  prospectId: number;
  playName: string;
  invite: LiveLinkedInInvite;
  linkedinUrl: string | null;
}): void {
  const ledger = getLedger();
  const profile = normalizeLinkedInProfile(input.linkedinUrl);
  if (profile && !releaseKnownConnection({ profile, workspace: currentWorkspaceName() })) {
    throw new Error(
      "LinkedIn says you are not connected, and the shared invite record could not be updated: send again to retry",
    );
  }
  ledger.recordLinkedInInviteEvent({
    prospectId: input.prospectId,
    playName: input.playName,
    stepIndex: input.invite.event.step_index,
    status: "withdrawn",
    metadata: { reason: "not-connected" },
  });
  // The message preview was written for a connection: drafted again as the request.
  ledger.clearCadenceDraft({ prospectId: input.prospectId, playName: input.playName });
  logEvent("linkedin.known_connection_voided", { play: input.playName });
}
