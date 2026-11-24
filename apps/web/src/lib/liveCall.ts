import type {
  CallRecordMode,
  CallRecordView,
  LiveCallView,
  LiveCallsResponse,
} from "@oneshot-gtm/shared-types";
import { bridgeStatusLine, isLive } from "./bridgeCall.ts";
import { formatDuration } from "./dialler.ts";

/**
 * The live call bar: every bridged call in flight in this workspace, on every
 * page, with whether it is being recorded, then the reader's own ended calls
 * still waiting on an outcome. Kept out of the component so the wording can
 * be read and tested without a browser.
 */

export type RecordingTone = "recording" | "muted" | "warn" | "ok";

/** Each tone's text colour, the same on the bar and in the dial panel. */
export const RECORDING_TONE_CLASS: Record<RecordingTone, string> = {
  recording: "text-[color:var(--ink-blocked-2)]",
  warn: "text-[color:var(--ink-spend-2)]",
  ok: "text-[color:var(--ink-receipt-2)]",
  muted: "text-ink-faint",
};

/**
 * What a call records, in a few words: while it is live, whether it is being
 * recorded now (or what it waits on); after, where its transcript is.
 */
export function recordingState(
  call: Pick<CallRecordView, "status" | "transcriptStatus" | "recordedFrom" | "discard">,
  mode: CallRecordMode,
): { label: string; tone: RecordingTone } {
  if (call.discard === "pending") return { label: "Deleting recording…", tone: "muted" };
  if (call.discard === "done") return { label: "Recording deleted", tone: "muted" };
  if (isLive(call)) {
    if (call.transcriptStatus === "pending") return { label: "● Recording", tone: "recording" };
    if (mode === "ask") return { label: "Not recording · ask first", tone: "warn" };
    if (mode === "always") return { label: "Records when they answer", tone: "muted" };
    return { label: "Not recorded · recording is off", tone: "muted" };
  }
  switch (call.transcriptStatus) {
    case "pending":
      return { label: "Transcribing…", tone: "muted" };
    case "ready":
      return { label: "Transcript ready", tone: "ok" };
    case "failed":
      return { label: "Transcript failed", tone: "warn" };
    default:
      return { label: "No transcript · not recorded", tone: "muted" };
  }
}

/**
 * Where a call is, naming the prospect (`name`, already masked by the
 * caller). A teammate's call ringing their own phone reads "their phone".
 */
export function liveCallLine(
  call: Pick<CallRecordView, "status" | "statusReason"> & { mine?: boolean },
  name: string | null | undefined,
): string {
  const who = name?.trim() || "them";
  switch (call.status) {
    case "ringing_prospect":
      return `Ringing ${who}…`;
    case "connected":
      return `On a call with ${who}`;
    case "ended":
      return `Call with ${who} ended`;
    case "failed":
      return bridgeStatusLine("failed", who, call.statusReason);
    default:
      return call.mine === false ? "Ringing their phone…" : "Ringing you…";
  }
}

/** When the server first read the call connected (ms); null without it, and unless connected. */
export function connectedAtMs(
  call: Pick<CallRecordView, "status" | "connectedAt"> | undefined,
): number | null {
  if (call?.status !== "connected" || !call.connectedAt) return null;
  const at = Date.parse(call.connectedAt);
  return Number.isNaN(at) ? null : at;
}

/** Seconds since the call connected, from the server's connect time; null unless connected. */
export function elapsedSec(
  call: Pick<CallRecordView, "status" | "connectedAt">,
  now: number = Date.now(),
): number | null {
  const at = connectedAtMs(call);
  return at == null ? null : Math.max(0, Math.floor((now - at) / 1000));
}

/** How often the bar re-reads: fast while one of your calls is live, as the read moves it on. */
export function liveCallsPollMs(data: LiveCallsResponse | undefined): number {
  if (data && !data.enabled) return 60_000;
  const calls = data?.calls ?? [];
  if (calls.some((c) => c.mine && isLive(c))) return 2_000;
  if (calls.some((c) => isLive(c))) return 5_000;
  return 20_000;
}

/**
 * Who placed a teammate's call: the email's name part ("Mia" for
 * mia@acme.com), "the owner" for the install's unlisted owner, and
 * "teammate" in privacy mode, where a screenshot must not name a member.
 */
export function memberLabel(member: string | null, masked: boolean): string {
  if (masked) return "teammate";
  if (member == null) return "the owner";
  const local = member.split("@")[0]?.trim() || member;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** The live call on this prospect, if any: your own first. */
export function liveCallFor(
  calls: readonly LiveCallView[] | undefined,
  prospectId: number,
): LiveCallView | null {
  const live = (calls ?? []).filter((c) => c.prospectId === prospectId && isLive(c));
  return live.find((c) => c.mine) ?? live[0] ?? null;
}

/**
 * Why Call is held for this prospect, as the server would refuse it: a
 * teammate is on a call with them, you are, or you are on a call with
 * someone else. Null when Call may go.
 */
export function callBlock(
  calls: readonly LiveCallView[] | undefined,
  prospectId: number,
  masked: boolean,
): string | null {
  const live = (calls ?? []).filter((x) => isLive(x));
  const theirs = live.find((x) => x.prospectId === prospectId && !x.mine);
  if (theirs)
    return `${masked ? "a teammate" : memberLabel(theirs.member, false)} is on a call with them`;
  if (live.some((x) => x.prospectId === prospectId && x.mine)) return "you're on a call with them";
  if (live.some((x) => x.mine)) return "hang up your other call first";
  return null;
}

/** The Calls row's short note for a live call: "Mia on a call · 2:10", "you're calling". */
export function rowLiveLine(call: LiveCallView, masked: boolean, now: number = Date.now()): string {
  const who = call.mine ? "you're" : memberLabel(call.member, masked);
  const what = call.status === "connected" ? "on a call" : "calling";
  const sec = elapsedSec(call, now);
  return `${who} ${what}${sec != null ? ` · ${formatDuration(sec)}` : ""}`;
}
