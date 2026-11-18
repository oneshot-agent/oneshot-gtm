import type { CallOutcome, CallRecordView, CurrentMember } from "@oneshot-gtm/shared-types";

/**
 * A bridged call as the dial panel shows it: Call rings the member's own
 * phone, then the prospect's; the panel polls the call for its live state,
 * then for the transcript and the suggested outcome. Kept out of the
 * component so it can be read and tested without a browser.
 */

export type BridgeStatus = NonNullable<CallRecordView["status"]>;

/** Read out at the start of a recorded call. */
export const CONSENT_LINE = "I record my calls so I can take notes — is that OK?";

/** How often the panel re-reads a call while it rings or is connected. */
export const LIVE_POLL_MS = 1500;
/** How often it re-reads an ended call while the transcript is on its way. */
export const TRANSCRIPT_POLL_MS = 4000;

/** Still ringing someone or connected: Hang up applies and Save waits. */
export function isLive(call: Pick<CallRecordView, "status"> | null | undefined): boolean {
  const s = call?.status;
  return s === "ringing_founder" || s === "ringing_prospect" || s === "connected";
}

/** The next read of this call: fast while live, slower for the transcript, then none. */
export function bridgePollMs(
  call: Pick<CallRecordView, "status" | "transcriptStatus"> | undefined,
): number | false {
  if (!call || isLive(call)) return LIVE_POLL_MS;
  return call.transcriptStatus === "pending" ? TRANSCRIPT_POLL_MS : false;
}

/** "Dana" from "Dana Reyes"; "them" when there is no name. */
export function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || "them";
}

/** The one line the panel shows for where the call is. */
export function bridgeStatusLine(status: BridgeStatus | undefined, first: string): string {
  switch (status) {
    case "ringing_prospect":
      return `Calling ${first}…`;
    case "connected":
      return "Connected";
    case "ended":
      return "Ended";
    case "failed":
      return "The call didn't go through";
    default:
      return "Ringing your phone…";
  }
}

/** "You" for the member's own side, "Them" for the prospect's. */
export function speakerLabel(speaker: "founder" | "prospect"): "You" | "Them" {
  return speaker === "founder" ? "You" : "Them";
}

/** The transcript as turns: consecutive sentences from one side read as one paragraph. */
export function transcriptTurns(
  transcript: NonNullable<CallRecordView["transcript"]>,
): { speaker: "founder" | "prospect"; text: string; startSec: number }[] {
  const turns: { speaker: "founder" | "prospect"; text: string; startSec: number }[] = [];
  for (const s of transcript) {
    const text = s.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) last.text = `${last.text} ${text}`;
    else turns.push({ speaker: s.speaker, text, startSec: s.startSec });
  }
  return turns;
}

/**
 * Who placed a call, as the history names them: "you" for the signed-in
 * member (or the install's owner, whose calls carry no email, on their own
 * install), the email for anyone else, "the owner" for the unlisted owner
 * seen by a member.
 */
export function callerLabel(member: string | null, me: CurrentMember | null | undefined): string {
  if (me && (me.email ?? null) === member) return "you";
  if (member == null) return "the owner";
  return member;
}

/** A bridged call left unlogged this long ago is still picked up when the panel opens. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The bridged call the panel picks up when it opens: the newest one not yet
 * logged, from the last few hours. That keeps Hang up and the transcript
 * after a reload, or after the member opened someone else mid-call.
 */
export function resumableCall(
  calls: CallRecordView[] | undefined,
  now: number = Date.now(),
): CallRecordView | null {
  const open = (calls ?? []).filter(
    (c) =>
      c.provider === "twilio" &&
      c.outcome == null &&
      c.status !== "failed" &&
      now - Date.parse(c.startedAt) < RESUME_WINDOW_MS,
  );
  open.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return open[0] ?? null;
}

/** What the suggestion puts in the panel: its outcome and note, untouched until the member changes them. */
export function suggestedPick(
  suggestion: CallRecordView["suggestion"],
): { outcome: CallOutcome; note: string } | null {
  return suggestion ? { outcome: suggestion.outcome, note: suggestion.note.trim() } : null;
}
