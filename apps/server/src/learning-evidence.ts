import {
  getLedger,
  getLinkedInInboxStore,
  getReplyReviewStore,
  linkedInAccountVisible,
  type LinkedInViewer,
} from "@oneshot-gtm/core";
import type {
  LearningEvidence,
  LearningEvidenceSample,
  LearningKind,
  LearningScope,
} from "@oneshot-gtm/shared-types";

/**
 * What a member may read of the evidence behind a learned change (#1040).
 * The rule is shared: its paraphrased instruction, its summary and its
 * counts. A LinkedIn message it was learned from is shown only to the member
 * who connected the account it is on, like the conversation itself. Every
 * route that returns learning evidence passes it through here.
 *
 * A sample stays only when its account is known. One whose account cannot
 * be told (an outreach draft, a send no longer on record) is left out: for
 * everyone but the one person using an install with no members, who reads
 * everything as before.
 */
export function evidenceFor(
  viewer: LinkedInViewer,
  evidence: LearningEvidence,
  about: { kind?: LearningKind; scope?: LearningScope } = {},
): LearningEvidence {
  const samples = evidence.samples ?? [];
  if (viewer.onlyUser || samples.length === 0) return evidence;
  const kept = samples.filter((s, i) =>
    carriesMessage(s)
      ? messageVisible(viewer, s, evidence.refs[i])
      : about.kind !== "prospect_angle" || prospectReplyVisible(viewer, s, about.scope?.prospectId),
  );
  if (kept.length === samples.length) return evidence;
  return { ...evidence, samples: kept, withheld: samples.length - kept.length };
}

/** A sent or drafted message, with the person it went to and what was said about it. */
const carriesMessage = (s: LearningEvidenceSample) =>
  s.sent != null || s.original != null || !!s.name || (s.feedback?.length ?? 0) > 0;

/** How `gatherAngleEvidence` labels a reply read from a prospect's LinkedIn events. */
const LINKEDIN_REPLY = /\(linkedin reply\)$/;

/** The stored account, when a viewer may read it. An account not on record is nobody's to read. */
function accountVisible(viewer: LinkedInViewer, accountKey: string | null | undefined): boolean {
  const account = accountKey ? getLinkedInInboxStore().account(accountKey) : null;
  return !!account && linkedInAccountVisible(account, viewer);
}

/**
 * A reply sample is written beside the send it quotes (`refs[i]` for
 * `samples[i]`), and the send names its conversation. Email is the
 * workspace's; a LinkedIn conversation is on one member's account.
 */
function messageVisible(
  viewer: LinkedInViewer,
  s: LearningEvidenceSample,
  ref: LearningEvidence["refs"][number] | undefined,
): boolean {
  if (s.channel === "email") return true;
  if (ref?.type !== "reply_send") return false;
  const origin = getReplyReviewStore().learning.sendOrigin(String(ref.id));
  // The reference must be the send this sample quotes, not its neighbor.
  if (!origin || origin.body.slice(0, 1500) !== s.sent) return false;
  if (origin.channel === "email") return true;
  const accountKey =
    getLinkedInInboxStore().thread(origin.threadKey)?.accountKey ??
    getReplyReviewStore().get(origin.threadKey)?.accountKey;
  return accountVisible(viewer, accountKey);
}

/**
 * A reply quoted behind a prospect's angle. One the sync recorded from a
 * LinkedIn account is that account's message; an email reply, or one
 * imported from another tool, is the workspace's.
 */
function prospectReplyVisible(
  viewer: LinkedInViewer,
  s: LearningEvidenceSample,
  prospectId: number | undefined,
): boolean {
  const events =
    prospectId == null || !s.text
      ? []
      : getLedger()
          .listChannelEventsForProspect(prospectId)
          .filter((e) => e.occurred_at === s.at && (e.body ?? "").startsWith(s.text!));
  // Labelled as LinkedIn's with no event left to say whose account it was on: left out.
  if (events.length === 0) return !LINKEDIN_REPLY.test(s.label ?? "");
  const mine = getLinkedInInboxStore()
    .accounts(viewer)
    .map((a) => `${a.key}:`);
  return events.every(
    (e) => e.source !== "oneshot-linkedin" || mine.some((k) => e.external_event_id.startsWith(k)),
  );
}
