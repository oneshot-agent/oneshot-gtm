import {
  CHANNEL_SPECS,
  canonicalLinkedInProfileKey,
  getLedger,
  loadConfig,
  logEvent,
  SendDeferredError,
  type LinkedInOperation,
} from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { voiceBlock } from "./_lib.ts";

/**
 * First touch on the LinkedIn channel: a connection request with a note, sent
 * through OneShot's invite route. Channel is a property of the queue row, not
 * of the play — a luma-events or github-stars row on LinkedIn is drafted here,
 * with that play's signal, instead of by the play's email prompt.
 */

/** How the caller reaches OneShot for the account that owns the LinkedIn connection. */
export interface LinkedInSender {
  accountId: string;
  call: (operation: LinkedInOperation) => Promise<unknown>;
}

export interface LinkedInFirstTouchRow {
  id: number;
  playName: string;
  payload: Record<string, unknown>;
  notes: string | null;
}

export interface LinkedInNoteDraft {
  subject: string;
  body: string;
  flags: string[];
  voiceKey: string | null;
}

export type LinkedInInviteOutcome =
  | {
      sent: true;
      status: "sent" | "pending" | "already_connected";
      invitationId: string;
      prospectId: number;
    }
  | { sent: false; flags: string[] };

function str(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** The profile URL an invite goes to, or null when the row has no usable LinkedIn profile. */
export function linkedInProfileOf(payload: Record<string, unknown>): string | null {
  const url = str(payload, "linkedinUrl");
  return url && canonicalLinkedInProfileKey(url) ? url : null;
}

/** The finder's reason this person surfaced, as prompt lines. Only facts the payload carries. */
function signalLines(row: LinkedInFirstTouchRow): string[] {
  const p = row.payload;
  const lines: string[] = [`PLAY: ${row.playName}`];
  const eventTitle = str(p, "eventTitle");
  if (eventTitle) {
    const role = str(p, "role");
    lines.push(
      `EVENT: ${eventTitle}${role ? ` (${role === "Host" ? "hosting" : "attending"})` : ""}`,
    );
    const date = str(p, "eventDateLocal");
    if (date) lines.push(`EVENT_DATE: ${date}`);
  }
  const repo = str(p, "repoFullName", "repo", "starredRepo");
  if (repo) lines.push(`REPO: ${repo}`);
  const round = str(p, "round");
  if (round)
    lines.push(
      `FUNDING: ${round}${str(p, "leadInvestor") ? ` led by ${str(p, "leadInvestor")}` : ""}`,
    );
  const job = str(p, "jobTitle");
  if (job) lines.push(`HIRING_FOR: ${job}`);
  const bio = str(p, "attendeeBio");
  if (bio) lines.push(`THEIR_BIO: ${bio.slice(0, 300)}`);
  const fit = str(p, "fitReason");
  if (fit) lines.push(`WHY_THEY_FIT: ${fit}`);
  if (row.notes && !row.notes.startsWith("auto:"))
    lines.push(`FINDER_NOTE: ${row.notes.slice(0, 200)}`);
  return lines;
}

/** Draft the connection-request note for one row. */
export async function draftLinkedInNote(
  row: LinkedInFirstTouchRow,
  opts: { draftAngle?: string | null } = {},
): Promise<LinkedInNoteDraft> {
  const cfg = loadConfig();
  const maxChars = CHANNEL_SPECS.linkedin.firstTouchMaxChars ?? 200;
  const name = str(row.payload, "name") ?? "them";
  const voice = voiceBlock("intro");
  const person = [
    `NAME: ${name}`,
    ...(str(row.payload, "title", "currentRole")
      ? [`ROLE: ${str(row.payload, "title", "currentRole")}`]
      : []),
    ...(str(row.payload, "company") ? [`COMPANY: ${str(row.payload, "company")}`] : []),
  ];
  const input = [
    `FOUNDER: ${cfg.founderName ?? ""}`,
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    "PERSON:",
    ...person.map((l) => `  ${l}`),
    "SIGNAL:",
    ...signalLines(row).map((l) => `  ${l}`),
    ...(opts.draftAngle ? [`ANGLE: ${opts.draftAngle}`] : []),
    ...(voice ? [`VOICE:\n${voice.text}`] : []),
    `MAX_CHARS: ${maxChars}`,
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("linkedin-invite-note") },
      { role: "user", content: input },
    ],
    temperature: 0.7,
    maxTokens: 600,
  });
  const body = res.content.trim().replace(/^"|"$/g, "");
  if (!body) throw new Error("empty note from the model");
  const flags: string[] = [];
  if (body.length > maxChars) flags.push(`note-too-long: ${body.length}/${maxChars} characters`);
  if (!linkedInProfileOf(row.payload))
    flags.push("no-linkedin: this row has no LinkedIn profile URL");
  return { subject: `LinkedIn invite → ${name}`, body, flags, voiceKey: voice?.key ?? null };
}

/** Codes OneShot's invite route reports as a failed job (docs: api-reference/linkedin/invite). */
function inviteErrorCode(err: unknown): string | null {
  const e = err as { code?: unknown; jobError?: unknown; message?: unknown };
  if (typeof e.code === "string") return e.code;
  const text = `${typeof e.jobError === "string" ? e.jobError : ""} ${typeof e.message === "string" ? e.message : ""}`;
  const m = text.match(
    /\b(email_required|note_limit_reached|note_too_long|rate_limited|account_send_limit|send_unverified)\b/,
  );
  return m ? m[1]! : null;
}

/**
 * Send a reviewed note as a connection request, and record it as this row's
 * step-0 touch on the LinkedIn channel. Never enrolls a cadence: an email
 * sequence for someone with no address would re-draft forever.
 */
export async function sendLinkedInInvite(input: {
  row: LinkedInFirstTouchRow;
  note: string;
  sender: LinkedInSender;
  workspace: string;
}): Promise<LinkedInInviteOutcome> {
  const profile = linkedInProfileOf(input.row.payload);
  if (!profile)
    return { sent: false, flags: ["no-linkedin: this row has no LinkedIn profile URL"] };
  let result: { invitation_id?: string; status?: string };
  try {
    result = (await input.sender.call({
      kind: "invite",
      accountId: input.sender.accountId,
      profile,
      note: input.note,
      // Stable per row: a retried drain returns the original invitation.
      idempotencyKey: `gtm:${input.workspace}:queue:${input.row.id}:invite`,
      playName: input.row.playName,
    })) as { invitation_id?: string; status?: string };
  } catch (err) {
    const code = inviteErrorCode(err);
    if (code === "rate_limited" || code === "account_send_limit") {
      throw new SendDeferredError(`LinkedIn invites paused for today (${code})`);
    }
    if (code) return { sent: false, flags: [`linkedin-${code.replace(/_/g, "-")}`] };
    throw err;
  }
  const status = result.status;
  if (
    !result.invitation_id ||
    (status !== "sent" && status !== "pending" && status !== "already_connected")
  ) {
    throw new Error(`unexpected LinkedIn invite result: ${JSON.stringify(result).slice(0, 160)}`);
  }
  const ledger = getLedger();
  const p = input.row.payload;
  const prospectId = ledger.upsertProspect({
    name: str(p, "name"),
    email: null,
    company: str(p, "company"),
    title: str(p, "title", "currentRole"),
    linkedin_url: profile,
    source: input.row.playName,
    source_profile_url: str(p, "sourceProfileUrl") ?? profile,
  });
  ledger.recordSequenceEvent({
    prospectId,
    playName: input.row.playName,
    stepIndex: 0,
    channel: "linkedin",
    status: "sent",
    metadata: {
      note: input.note,
      invitationId: result.invitation_id,
      inviteStatus: status,
    },
  });
  logEvent("linkedin.invite_sent", { play: input.row.playName, status });
  return { sent: true, status, invitationId: result.invitation_id, prospectId };
}
