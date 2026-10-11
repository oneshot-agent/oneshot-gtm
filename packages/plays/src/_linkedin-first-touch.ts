import {
  CHANNEL_SPECS,
  canInviteOnLinkedInNow,
  canonicalLinkedInProfileKey,
  claimLinkedInProfile,
  getLedger,
  guardFlag,
  normalizeLinkedInProfile,
  type LinkedInGuardReason,
  loadConfig,
  logEvent,
  noteAccountInviteCapReached,
  reserveLinkedInInvite,
  SendDeferredError,
  type LinkedInOperation,
} from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { enrollInCadence } from "./_cadence.ts";
import { voiceBlock } from "./_lib.ts";

/**
 * First touch on the LinkedIn channel: a connection request with a note, sent
 * through OneShot's invite route. Channel is a property of the queue row, not
 * of the play. A luma-events or github-stars row on LinkedIn is drafted here,
 * with that play's signal, instead of by the play's email prompt.
 */

/** How the caller reaches OneShot for the account that owns the LinkedIn connection. */
export interface LinkedInSender {
  accountId: string;
  /** Workspace that owns the account: recorded so a withdrawal reaches the same one. */
  workspace?: string;
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
  | {
      sent: false;
      flags: string[];
      /** Set when the invite guard refused: counted per reason in drain output. */
      guard?: LinkedInGuardReason;
    };

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

/**
 * The finder's reason this person surfaced, as prompt lines: shared by every
 * non-email first touch. Only facts the payload carries.
 */
export function signalLines(row: LinkedInFirstTouchRow): string[] {
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
  const post = str(p, "postTitle");
  if (post) lines.push(`LAUNCH_POST: ${post}`);
  const episode = str(p, "episodeTitle");
  if (episode)
    lines.push(`PODCAST: ${episode}${str(p, "podcastName") ? ` on ${str(p, "podcastName")}` : ""}`);
  const stack = str(p, "vendorStack");
  if (stack) lines.push(`THEIR_STACK: ${stack}`);
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

/** LinkedIn's own limit on a connection-request note (OneShot enforces it too). */
export const LINKEDIN_NOTE_HARD_LIMIT = 300;

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

/**
 * Codes OneShot's invite route reports for a job that failed without sending
 * (docs: api-reference/linkedin/invite). Only these prove non-delivery.
 * `send_unverified` is deliberately absent (the invite may have gone out), as
 * is every transport or local code (ECONNRESET, a database error, ...).
 */
const NOT_DELIVERED_CODES = new Set([
  "email_required",
  "note_limit_reached",
  "note_too_long",
  "rate_limited",
  "account_send_limit",
]);

function inviteErrorCode(err: unknown): string | null {
  const e = err as { code?: unknown; jobError?: unknown; message?: unknown };
  if (typeof e.code === "string") return NOT_DELIVERED_CODES.has(e.code) ? e.code : null;
  const text = `${typeof e.jobError === "string" ? e.jobError : ""} ${typeof e.message === "string" ? e.message : ""}`;
  const m = text.match(
    /\b(email_required|note_limit_reached|note_too_long|rate_limited|account_send_limit)\b/,
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
  // A note OneShot would refuse never leaves; the shorter draft target
  // stays a review flag, not a block.
  const note = input.note.trim();
  if (!note) return { sent: false, flags: ["empty-note: write a note before sending"] };
  if (note.length > LINKEDIN_NOTE_HARD_LIMIT) {
    return {
      sent: false,
      flags: [`note-too-long: ${note.length}/${LINKEDIN_NOTE_HARD_LIMIT} characters`],
    };
  }
  // The guard every invite passes: a personal profile, a person's name, no
  // opt-out or engagement elsewhere, a passing ICP verdict, and a profile
  // nobody has invited. A refusal is recoverable; a sent invite is not. It
  // runs on the stored URL as is, so an X, GitHub or company URL is refused
  // with a guard reason (counted per reason in drain output) instead of
  // dropping out as a bare "no profile".
  const p0 = input.row.payload;
  const target = normalizeLinkedInProfile(profile);
  const override = p0["icpOverride"];
  const verdict = canInviteOnLinkedInNow({
    name: str(p0, "name"),
    company: str(p0, "company"),
    email: str(p0, "email", "founderEmail"),
    linkedinUrl: str(p0, "linkedinUrl"),
    icpVerdict: str(p0, "icpVerdict"),
    icpOverridden: typeof override === "object" && override !== null,
  });
  if (!verdict.ok) return { sent: false, flags: [guardFlag(verdict)], guard: verdict.reason };
  if (!target || !profile) {
    return {
      sent: false,
      flags: ["invalid-profile: the LinkedIn URL is not a personal profile"],
      guard: "invalid-profile",
    };
  }
  // Reserve the profile in the shared DB before any await, so a second
  // workspace on the same account can't invite it while this one is in flight.
  const claimed = claimLinkedInProfile({ profile: target, workspace: input.workspace });
  if (!claimed.ok) return { sent: false, flags: [guardFlag(claimed)], guard: claimed.reason };
  const claim = claimed.claim;
  // Take a slot of the workspace share (and check the account has invites
  // left) before the API call. Deferred when either is used up.
  let slot: Awaited<ReturnType<typeof reserveLinkedInInvite>>;
  try {
    slot = await reserveLinkedInInvite({
      accountId: input.sender.accountId,
      fetchAccount: () => input.sender.call({ kind: "account", accountId: input.sender.accountId }),
      workspace: input.workspace,
    });
  } catch (err) {
    claim.release();
    throw err;
  }
  // From here the invite may go out at any moment: make the claim durable
  // first. Past this point only a failure the provider reports as "not
  // delivered" frees the profile; a timeout, a lost worker, a bad result or a
  // local error after the call leaves it suppressed (a retry could invite
  // twice, and a skipped invite can be sent by hand).
  try {
    claim.dispatch();
  } catch (err) {
    slot.release();
    claim.release();
    throw err;
  }
  let result: { invitation_id?: string; status?: string };
  try {
    result = (await input.sender.call({
      kind: "invite",
      accountId: input.sender.accountId,
      profile: target.url,
      note,
      // Stable per row: a retried drain returns the original invitation.
      idempotencyKey: `gtm:${input.workspace}:queue:${input.row.id}:invite`,
      playName: input.row.playName,
    })) as { invitation_id?: string; status?: string };
  } catch (err) {
    slot.release();
    const code = inviteErrorCode(err);
    // Only a code OneShot reports for a failed job proves nothing was sent.
    if (code) claim.release();
    if (code === "rate_limited" || code === "account_send_limit") {
      noteAccountInviteCapReached(input.sender.accountId);
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
    // The call returned, so the invite may have gone out: the claim stays.
    slot.release();
    throw new Error(`unexpected LinkedIn invite result: ${JSON.stringify(result).slice(0, 160)}`);
  }
  slot.confirm();
  claim.confirm();
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
  ledger.recordLinkedInInviteEvent({
    prospectId,
    playName: input.row.playName,
    stepIndex: 0,
    status: "sent",
    metadata: {
      // subject/body/label: what the cadence timeline and follow-up prompts read.
      subject: "LinkedIn invite",
      body: note,
      label: "connection request",
      note,
      invitationId: result.invitation_id,
      inviteStatus: status,
      // The account that sent it: a withdrawal must go to the same one.
      accountId: input.sender.accountId,
      ...(input.sender.workspace ? { accountWorkspace: input.sender.workspace } : {}),
    },
  });
  // The LinkedIn sequence: a message once the invite is accepted, then a close.
  enrollInCadence({ prospectId, playName: input.row.playName, channel: "linkedin" });
  logEvent("linkedin.invite_sent", { play: input.row.playName, status });
  return { sent: true, status, invitationId: result.invitation_id, prospectId };
}
