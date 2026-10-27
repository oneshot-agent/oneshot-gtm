import {
  canConnectAsFriendNow,
  getLedger,
  loadConfig,
  type InboxReplyRecord,
} from "@oneshot-gtm/core";
import { loadPrompt } from "@oneshot-gtm/intel";
import {
  LINKEDIN_FRIEND_PLAY,
  LINKEDIN_FRIEND_STEP_INDEX,
  type LinkedInFriendDraftView,
} from "@oneshot-gtm/shared-types";
import {
  LINKEDIN_NOTE_HARD_LIMIT,
  sendLinkedInInvite,
  type LinkedInInviteOutcome,
  type LinkedInSender,
} from "./_linkedin-first-touch.ts";
import { draftWithRepair, lintLinkedInNote } from "./_linkedin-evidence.ts";
import { voiceBlock } from "./_lib.ts";
import { templatedLinkedIn } from "./_linkedin-template.ts";

/**
 * The warm LinkedIn connect (#791): a short, no-pitch connection request to
 * someone who replied positively to an email. Never automatic: the founder
 * previews and edits the note, and only the send route calls `sendFriendInvite`.
 * Nothing follows an accepted invite; the Replies thread is where the
 * conversation continues.
 */

/** The friend note's own limit: the hard LinkedIn ceiling. */
export const FRIEND_NOTE_MAX_CHARS = LINKEDIN_NOTE_HARD_LIMIT;

const EXCHANGE_BODY_CHARS = 280;

function lintFriendNote(text: string): string[] {
  const flags = lintLinkedInNote(text, FRIEND_NOTE_MAX_CHARS);
  if (text.includes("?")) flags.push("note-question: no question in a friend note");
  return flags;
}

/** What the emails were about, as one prompt line pair: the latest positive human reply, trimmed. */
function emailExchange(replies: InboxReplyRecord[]): string[] {
  const reply = replies.findLast((r) => (r.kind ?? "human") === "human");
  if (!reply) return [];
  const body = reply.body.replace(/\s+/g, " ").trim().slice(0, EXCHANGE_BODY_CHARS);
  return [
    ...(reply.subject ? [`SUBJECT: ${reply.subject.slice(0, 120)}`] : []),
    ...(body ? [`THEIR_REPLY: ${body}`] : []),
  ];
}

export type FriendDraftResult =
  | { ok: true; draft: LinkedInFriendDraftView }
  | { ok: false; reason: string };

/** Draft the note for one prospect, or say why they don't qualify. Sends nothing. */
export async function draftFriendNote(prospectId: number): Promise<FriendDraftResult> {
  const verdict = canConnectAsFriendNow(prospectId);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const { prospect } = verdict;
  const cfg = loadConfig();
  const templated = templatedLinkedIn("friend", cfg, { name: prospect.name });
  if (templated) {
    // Held to the same rules the send route checks an edited note against.
    return {
      ok: true,
      draft: {
        note: templated.text,
        flags: lintFriendNote(templated.text),
        maxChars: FRIEND_NOTE_MAX_CHARS,
      },
    };
  }
  const replies = getLedger().listInboxRepliesForProspect(prospectId);
  const voice = voiceBlock("intro");
  const context = [
    `MODE: friend`,
    `FOUNDER: ${cfg.founderName ?? ""}`,
    "PERSON:",
    `  NAME: ${prospect.name ?? "them"}`,
    ...(prospect.title ? [`  ROLE: ${prospect.title}`] : []),
    ...(prospect.company ? [`  COMPANY: ${prospect.company}`] : []),
    "EMAIL_EXCHANGE:",
    ...emailExchange(replies).map((l) => `  ${l}`),
    ...(voice ? [`VOICE:\n${voice.text}`] : []),
    `MAX_CHARS: ${FRIEND_NOTE_MAX_CHARS}`,
  ].join("\n");
  const drafted = await draftWithRepair({
    system: loadPrompt("linkedin-invite-note"),
    context,
    lint: lintFriendNote,
    maxTokens: 600,
  });
  if (!drafted.text) return { ok: false, reason: "the model returned an empty note" };
  return {
    ok: true,
    draft: { note: drafted.text, flags: drafted.flags, maxChars: FRIEND_NOTE_MAX_CHARS },
  };
}

export type FriendSendResult =
  | { sent: true; status: "sent" | "pending" | "already_connected"; invitationId: string }
  | { sent: false; flags: string[] };

/**
 * Send the note the founder reviewed. Checks the reply allow-list again, then
 * goes through the same send path as every invite (guard, profile claim,
 * workspace quota share), recorded with the invite marker at a non-zero step
 * under the friend play. No cadence is enrolled, so no message follows.
 */
export async function sendFriendInvite(input: {
  prospectId: number;
  note: string;
  sender: LinkedInSender;
  workspace: string;
}): Promise<FriendSendResult> {
  const verdict = canConnectAsFriendNow(input.prospectId);
  if (!verdict.ok) {
    // A guard refusal keeps the `reason: detail` shape every invite refusal has.
    return {
      sent: false,
      flags: [
        verdict.guard ? `${verdict.guard}: ${verdict.reason}` : `not-eligible: ${verdict.reason}`,
      ],
    };
  }
  const { prospect } = verdict;
  // The friend-note contract (no question, pitch or link) holds for an edited
  // note too; the sender only checks empty and over-limit.
  const noteFlags = lintFriendNote(input.note).filter(
    (flag) =>
      flag.startsWith("note-question:") ||
      flag.startsWith("note-pitch:") ||
      flag.startsWith("note-link:"),
  );
  if (noteFlags.length > 0) return { sent: false, flags: noteFlags };
  const out: LinkedInInviteOutcome = await sendLinkedInInvite({
    row: {
      id: input.prospectId,
      playName: LINKEDIN_FRIEND_PLAY,
      payload: {
        name: prospect.name,
        company: prospect.company,
        email: prospect.email,
        title: prospect.title,
        linkedinUrl: prospect.linkedin_url,
      },
      notes: null,
    },
    note: input.note,
    sender: input.sender,
    workspace: input.workspace,
    continuation: { prospectId: input.prospectId, stepIndex: LINKEDIN_FRIEND_STEP_INDEX },
    friend: true,
  });
  return out.sent
    ? { sent: true, status: out.status, invitationId: out.invitationId }
    : { sent: false, flags: out.flags };
}
