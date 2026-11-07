import {
  CHANNEL_SPECS,
  canInviteOnLinkedInNow,
  canonicalLinkedInProfileKey,
  claimLinkedInProfile,
  getLedger,
  guardFlag,
  KNOWN_CONNECTION_VIA,
  normalizeLinkedInProfile,
  type LinkedInGuardReason,
  type LinkedInGuardVerdict,
  loadConfig,
  logEvent,
  noteAccountInviteCapReached,
  reserveLinkedInInvite,
  SendDeferredError,
  settleLinkedInInviteClaim,
  awaitLinkedInJob,
  isLinkedInSendPending,
  LinkedInSendPendingError,
  startLinkedInSend,
  accountInviteLimits,
  heldInviteSlot,
  type InviteSlot,
  linkedInFailure,
  type LinkedInFailure,
  type LinkedInJobOutcome,
  type LinkedInOperation,
} from "@oneshot-gtm/core";
import { loadPrompt } from "@oneshot-gtm/intel";
import { enrollInCadence } from "./_cadence.ts";
import {
  agedEvidence,
  draftWithRepair,
  lintLinkedInNote,
  lintSharedCohort,
} from "./_linkedin-evidence.ts";
import { learningBlock, stampLearningInput, voiceBlock } from "./_lib.ts";
import {
  type KnownConnection,
  KNOWN_CONNECTION_SUBJECT,
  knownConnectionDay,
} from "./_linkedin-connection.ts";
import { templatedLinkedIn } from "./_linkedin-template.ts";
import { offerCandidatesOf, offerOf, playMakesOffer } from "./_prospect-offer.ts";

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
  /** Fingerprint of the approved learned-guidance set in the prompt (#813). */
  learningKey?: string | null;
  /** Whether the prompt carried an evidence clause; recorded on the invite when it is sent (#792). */
  evidenceClause?: boolean;
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
  opts: {
    draftAngle?: string | null;
    /** Facts about earlier contact (an email cadence that got no reply), as prompt lines. */
    priorContact?: string[];
    /** When the person was first contacted on this play; defaults to now (this note is the first touch). */
    contactedAt?: Date;
    /** The trigger's buyer type, when it sets one. */
    buyerType?: string | null;
  } = {},
): Promise<LinkedInNoteDraft> {
  const cfg = loadConfig();
  const maxChars = CHANNEL_SPECS.linkedin.firstTouchMaxChars ?? 200;
  const name = str(row.payload, "name") ?? "them";
  const now = new Date();
  const evidence = agedEvidence(row.payload, { contactedAt: opts.contactedAt ?? now, now });
  // The note never makes the offer, so a template gets none.
  const templated = templatedLinkedIn("note", cfg, { name: str(row.payload, "name"), evidence });
  if (templated) {
    return {
      subject: `LinkedIn invite → ${name}`,
      body: templated.text,
      flags: noteFlags(row, templated.text, maxChars, []),
      voiceKey: null,
      learningKey: null,
      // Recorded for the funnel: whether the note sent actually names why.
      evidenceClause: templated.usesEvidence,
    };
  }
  const voice = voiceBlock("intro");
  const learned = learningBlock({
    channel: "linkedin",
    stage: "first_touch",
    cfg,
    email: str(row.payload, "email"),
    playName: row.playName,
    campaignAngle: opts.draftAngle,
    replaceProspectAngle: !!opts.draftAngle,
  });
  const person = [
    `NAME: ${name}`,
    ...(str(row.payload, "title", "currentRole")
      ? [`ROLE: ${str(row.payload, "title", "currentRole")}`]
      : []),
    ...(str(row.payload, "company") ? [`COMPANY: ${str(row.payload, "company")}`] : []),
  ];
  const input = [
    `FOUNDER: ${cfg.founderName ?? ""}`,
    ...(cfg.founderCohort?.trim() ? [`SENDER_COHORT: ${cfg.founderCohort.trim()}`] : []),
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    "PERSON:",
    ...person.map((l) => `  ${l}`),
    "SIGNAL:",
    ...signalLines(row).map((l) => `  ${l}`),
    ...(opts.draftAngle ? [`ANGLE: ${opts.draftAngle}`] : []),
    ...(opts.priorContact?.length
      ? ["PRIOR_CONTACT:", ...opts.priorContact.map((l) => `  ${l}`)]
      : []),
    ...(evidence ? [`EVIDENCE_CLAUSE: ${evidence}`] : []),
    ...((opts.buyerType ?? str(row.payload, "buyerType"))
      ? [`BUYER_TYPE: ${opts.buyerType ?? str(row.payload, "buyerType")}`]
      : []),
    // The note never makes the offer; its subject is the common ground.
    ...(offerOf(row.payload) && playMakesOffer(row.playName)
      ? [`OFFER (context only; the note never makes it): ${offerOf(row.payload)!.offer}`]
      : []),
    ...(voice ? [`VOICE:\n${voice.text}`] : []),
    ...(learned ? [learned.text] : []),
    `MAX_CHARS: ${maxChars}`,
  ].join("\n");
  stampLearningInput(learned, input);
  const drafted = await draftWithRepair({
    system: loadPrompt("linkedin-invite-note"),
    context: input,
    lint: (text) => [
      ...lintLinkedInNote(text, maxChars),
      ...lintSharedCohort(text, cfg.founderCohort),
    ],
    maxTokens: 600,
  });
  const body = drafted.text;
  if (!body) throw new Error("empty note from the model");
  return {
    subject: `LinkedIn invite → ${name}`,
    body,
    flags: noteFlags(row, body, maxChars, drafted.flags),
    voiceKey: voice?.key ?? null,
    learningKey: learned?.key ?? null,
    evidenceClause: Boolean(evidence),
  };
}

/** A note's review flags: its own, the length target, and a missing profile. */
function noteFlags(
  row: LinkedInFirstTouchRow,
  body: string,
  maxChars: number,
  drafted: string[],
): string[] {
  const flags = [...drafted];
  if (body.length > maxChars && !flags.some((f) => f.startsWith("note-too-long")))
    flags.push(`note-too-long: ${body.length}/${maxChars} characters`);
  if (!linkedInProfileOf(row.payload))
    flags.push("no-linkedin: this row has no LinkedIn profile URL");
  return flags;
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
  // The code decides. A failed job's `jobError` is a sentence: one that
  // mentions a rate limit is not `rate_limited` when the code says otherwise.
  // A transport or local code (ECONNRESET, ...) proves nothing either.
  if (typeof e.code === "string" && e.code) return NOT_DELIVERED_CODES.has(e.code) ? e.code : null;
  // An older answer with no code names it in `jobError` or the message.
  const text = `${typeof e.jobError === "string" ? e.jobError : ""} ${
    typeof e.message === "string" ? e.message : ""
  }`;
  if (/\bsend_unverified\b/.test(text)) return null;
  const m = text.match(
    /\b(email_required|note_limit_reached|note_too_long|rate_limited|account_send_limit)\b/,
  );
  return m ? m[1]! : null;
}

/** The invite caps: OneShot paused this account's invites for the day. */
const CAP_CODES = new Set(["rate_limited", "account_send_limit"]);

/**
 * An invite that hit a cap and may have gone out anyway: a synchronous HTTP
 * 429 (whatever its text says), or a cap code on anything but a failed job.
 * Only a failed job (JobError) proves nothing was sent. Null otherwise; else
 * what to show.
 */
function cappedMaybeSent(err: unknown): string | null {
  const e = (err ?? {}) as { name?: unknown; statusCode?: unknown };
  if (e.name === "JobError") return null;
  const code = inviteErrorCode(err);
  if (e.statusCode === 429) return code && CAP_CODES.has(code) ? code : "429";
  return code && CAP_CODES.has(code) ? code : null;
}

/**
 * The flag (and guard reason) of an invite LinkedIn refused: nothing went
 * out, so the profile is free. The parentheses name the code and the
 * provider's error type (`upstream`); `reason` is OneShot's sentence.
 */
export function inviteRefusedFlag(
  code: string,
  upstream?: string | null,
  reason?: string | null,
): string {
  const tag = upstream && upstream !== code ? `${code}: ${upstream}` : code;
  return guardFlag({
    ok: false,
    reason: "linkedin-invite-refused",
    detail: `LinkedIn refused this invite (${tag})${reason ? `: ${reason}` : ""}`,
  });
}

/** Invite codes that end the profile: nobody can be invited there, so nothing went out. */
const UNAVAILABLE_RECIPIENT = new Set(["recipient_unavailable", "invalid_recipient"]);

/**
 * A failed invite whose recipient can't be invited (`recipient_unavailable`,
 * or LinkedIn's `invalid_recipient`): refused, no invitation to look up.
 * Read from the code (an older answer: a `jobError` that is the code). Null
 * for any other error, and for `send_unverified`.
 */
export function unavailableRecipient(err: unknown): (LinkedInFailure & { code: string }) | null {
  const failure = linkedInFailure(err);
  return failure.code && UNAVAILABLE_RECIPIENT.has(failure.code)
    ? { ...failure, code: failure.code }
    : null;
}

/**
 * Proof that a failed invite never reached LinkedIn: the failure names its
 * invitation (`partialResult.invitation_id`) and OneShot reads that
 * invitation as `not_sent`. Returns the failure's code, or null without that
 * proof (no invitation named, an unreadable invitation, any other status,
 * or `send_unverified`, after which the invite may have gone out).
 */
export async function refusedInviteCode(
  err: unknown,
  sender: Pick<LinkedInSender, "accountId" | "call">,
): Promise<string | null> {
  const e = (err ?? {}) as { code?: unknown; jobError?: unknown; partialResult?: unknown };
  const { code } = linkedInFailure(err);
  if (code === "send_unverified") return null;
  // An older answer with no code: its job text may still say so.
  if (!code && /\bsend_unverified\b/.test(String(e.jobError ?? ""))) return null;
  const partial = e.partialResult as { invitation_id?: unknown } | undefined;
  const invitationId = partial?.invitation_id;
  if (typeof invitationId !== "string" || !invitationId) return null;
  try {
    const invitation = (await sender.call({
      kind: "invitation",
      accountId: sender.accountId,
      invitationId,
    })) as { status?: unknown } | null;
    if (invitation?.status !== "not_sent") return null;
  } catch {
    return null;
  }
  return code && /^[a-z][a-z_]{1,39}$/.test(code) ? code : "not_sent";
}

/** The invite's idempotency key: stable per row (or per cadence step), so a retry returns the original invitation. */
export function linkedInInviteKey(input: {
  row: Pick<LinkedInFirstTouchRow, "id" | "playName">;
  workspace: string;
  continuation?: { prospectId: number; stepIndex: number } | undefined;
}): string {
  return input.continuation
    ? `gtm:${input.workspace}:cadence:${input.continuation.prospectId}:${input.row.playName}:${input.continuation.stepIndex}:invite`
    : `gtm:${input.workspace}:queue:${input.row.id}:invite`;
}

/** What `sendLinkedInInvite` takes; also what a pending invite stores to finish later. */
export interface SendLinkedInInviteInput {
  row: LinkedInFirstTouchRow;
  note: string;
  sender: LinkedInSender;
  workspace: string;
  continuation?: { prospectId: number; stepIndex: number };
  /**
   * A warm connect to someone who replied to an email (#791). The caller has
   * checked the reply allow-list; the guard skips the email-reply and ICP
   * refusals and keeps every other. Needs `continuation`: it is recorded at a
   * non-zero step and enrolls no cadence, so no message ever follows.
   */
  friend?: boolean;
  /** Whether the note was drafted with an evidence clause in its prompt; stored on the invite so later prompt changes don't rewrite history (#792). Absent when unknown. */
  evidenceClause?: boolean | undefined;
  /**
   * Only check an invite already pending under this key; never invite. The
   * LinkedIn sweep's mode: with nothing pending it answers NOT_PENDING_FLAG.
   */
  resumeOnly?: boolean;
}

/** The invite guard for a row (or cadence step), as every invite runs it. */
function inviteVerdict(
  input: SendLinkedInInviteInput,
  opts: { ownInviteClaim?: string } = {},
): LinkedInGuardVerdict {
  const p = input.row.payload;
  const override = p["icpOverride"];
  return canInviteOnLinkedInNow({
    ...(input.continuation ? { prospectId: input.continuation.prospectId } : {}),
    name: str(p, "name"),
    company: str(p, "company"),
    email: str(p, "email", "founderEmail"),
    linkedinUrl: str(p, "linkedinUrl"),
    icpVerdict: str(p, "icpVerdict"),
    icpOverridden: typeof override === "object" && override !== null,
    ...(input.friend ? { friend: true } : {}),
    ...(opts.ownInviteClaim ? { ownInviteClaim: opts.ownInviteClaim } : {}),
    // Off a queue row it is this workspace's first touch.
    ...(!input.continuation && !input.friend ? { firstTouch: true } : {}),
  });
}

/** What `sendLinkedInInvite` answers with `resumeOnly` when nothing is pending under the key. */
export const NOT_PENDING_FLAG = "not-pending: no pending invite under this key";

/**
 * Send a reviewed note as a connection request, and record it as this row's
 * step-0 touch on the LinkedIn channel. Never enrolls a cadence: an email
 * sequence for someone with no address would re-draft forever.
 *
 * With `continuation` the invite is a step of an email cadence that carries on
 * onto LinkedIn: it is recorded (with the invite marker) at that step, never
 * at step 0, for the prospect the cadence already has, and it enrolls nothing:
 * the cadence it belongs to is already running.
 *
 * An invite still running when the wait ends throws LinkedInSendPendingError
 * and is kept as pending under its idempotency key. Called again with the
 * same key it checks that job and never invites a second time; the LinkedIn
 * sweep resolves it the same way.
 */
export async function sendLinkedInInvite(
  input: SendLinkedInInviteInput,
): Promise<LinkedInInviteOutcome> {
  const profile = linkedInProfileOf(input.row.payload);
  const target = normalizeLinkedInProfile(profile);
  // The row's key, moved on once per invite job that failed: OneShot replays
  // a failed job under its own key, so a retry needs a new one.
  const idempotencyKey = getLedger().linkedInSendAttempts.key(linkedInInviteKey(input));
  // Already sent and still pending: check that job. The guard would refuse
  // (the claim is ours), and a second invite call must never be made. What is
  // recorded is the note LinkedIn received, whatever the draft says now.
  const pending = getLedger().linkedInPending.get(idempotencyKey);
  if (pending && target && profile) {
    const byKey = (outcome: "confirm" | "release") => () => {
      settleLinkedInInviteClaim({ profile: target, workspace: input.workspace, outcome });
    };
    const sentNote = pending.detail["note"];
    const pendingNote = typeof sentNote === "string" ? sentNote : input.note.trim();
    // No job id: a 429 answered the invite, which may have gone out. Only the
    // same key may try again: OneShot answers it with that invite if it was
    // made, and makes it if not. Never from the sweep, and not while the
    // account is paused for the day.
    const unconfirmed = !pending.requestId;
    if (unconfirmed) {
      if (input.resumeOnly) return { sent: false, flags: [NOT_PENDING_FLAG] };
      // Everything may have changed since the 429 (an opt-out, a reply, a
      // conversation): the guard runs again, passing over only this invite's
      // own claim. A refusal sends nothing. The claim stays either way, since
      // the first invite may have gone out. A final refusal also ends the
      // resend, so neither Send nor the sweep picks it up again; one that
      // could not be checked (`guard-unavailable`) keeps it for the next try.
      const verdict = inviteVerdict(input, { ownInviteClaim: input.workspace });
      if (!verdict.ok) {
        if (verdict.reason !== "guard-unavailable")
          getLedger().linkedInPending.clear(idempotencyKey);
        return { sent: false, flags: [guardFlag(verdict)], guard: verdict.reason };
      }
      const limits = await accountInviteLimits(input.sender.accountId, () =>
        input.sender.call({ kind: "account", accountId: input.sender.accountId }),
      );
      if (limits && limits.remaining !== null && limits.remaining <= 0)
        throw new SendDeferredError("LinkedIn invites paused for today (account limit reached)");
    }
    return settleInvite(input, {
      note: pendingNote,
      profile,
      idempotencyKey,
      claim: { confirm: byKey("confirm"), release: byKey("release") },
      // The slot was counted when the invite went pending: kept if it went
      // out, given back if it proves not sent.
      slot: heldInviteSlot(
        typeof pending.detail["slotId"] === "number" ? pending.detail["slotId"] : null,
      ),
      job: unconfirmed
        ? async () =>
            awaitLinkedInJob(
              await startLinkedInSend(() =>
                input.sender.call({
                  kind: "invite",
                  accountId: input.sender.accountId,
                  profile: target.url,
                  note: pendingNote,
                  idempotencyKey,
                  playName: input.row.playName,
                }),
              ),
              input.sender.call,
            )
        : () =>
            awaitLinkedInJob(
              { status: "pending", request_id: pending.requestId },
              input.sender.call,
            ),
    });
  }
  if (input.resumeOnly) return { sent: false, flags: [NOT_PENDING_FLAG] };
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
  const verdict = inviteVerdict(input);
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
  return settleInvite(input, {
    note,
    profile,
    idempotencyKey,
    claim,
    slot,
    // A key that already ran answers with its original job, polled here.
    job: async () =>
      awaitLinkedInJob(
        await startLinkedInSend(() =>
          input.sender.call({
            kind: "invite",
            accountId: input.sender.accountId,
            profile: target.url,
            note,
            idempotencyKey,
            playName: input.row.playName,
          }),
        ),
        input.sender.call,
      ),
  });
}

/**
 * The invite call (or the check of one already made) and everything after
 * it: the outcome recorded, the claim and the slot settled. Shared by a
 * first send and a resumed one, so both record the same way.
 */
async function settleInvite(
  input: SendLinkedInInviteInput,
  ctx: {
    note: string;
    profile: string;
    idempotencyKey: string;
    claim: { confirm: () => void; release: () => void };
    slot: InviteSlot;
    job: () => Promise<LinkedInJobOutcome>;
  },
): Promise<LinkedInInviteOutcome> {
  const { note, profile, claim, slot } = ctx;
  const ledger = getLedger();
  const settled = () => ledger.linkedInPending.clear(ctx.idempotencyKey);
  /** Kept under its key until its outcome is read; `requestId` empty when none is known. */
  const keepPending = (requestId: string) =>
    ledger.linkedInPending.record({
      idempotencyKey: ctx.idempotencyKey,
      kind: "invite",
      requestId,
      accountWorkspace: input.sender.workspace ?? input.workspace,
      accountId: input.sender.accountId,
      prospectId: input.continuation?.prospectId ?? null,
      playName: input.row.playName,
      stepIndex: input.continuation?.stepIndex ?? null,
      queueId: !input.continuation && input.row.id > 0 ? input.row.id : null,
      detail: {
        row: input.row,
        note,
        // The day's slot it counts against, freed if it proves not sent.
        ...(slot.id != null ? { slotId: slot.id } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
        ...(input.friend ? { friend: true } : {}),
        ...(input.evidenceClause !== undefined ? { evidenceClause: input.evidenceClause } : {}),
      },
    });
  let result: { invitation_id?: string; status?: string };
  try {
    const job = await ctx.job();
    if (job.state === "pending") {
      // Accepted and still running: it may go out, so the claim stays and
      // the slot counts.
      slot.confirm();
      keepPending(job.requestId);
      throw new LinkedInSendPendingError(job.requestId, ctx.idempotencyKey);
    }
    result = job.result as { invitation_id?: string; status?: string };
  } catch (err) {
    if (isLinkedInSendPending(err)) throw err;
    // A failed job: the next invite for this row goes under a new key.
    ledger.linkedInSendAttempts.noteFailed(ctx.idempotencyKey, err);
    const capped = cappedMaybeSent(err);
    if (capped) {
      // A 429 (or a cap outside a failed job) may have gone out: the claim
      // stays, the slot counts and the key is kept, so the next try (or the
      // sweep, once OneShot has a record) finds that invite. The account's
      // invites pause for the day; the step or row stays due.
      slot.confirm();
      noteAccountInviteCapReached(input.sender.accountId);
      keepPending("");
      throw new SendDeferredError(`LinkedIn invites paused for today (${capped})`);
    }
    // The day's slot goes back only on proof that nothing went out; any other
    // failure (unverified, a lost answer) may have sent it, so it stays counted.
    const unavailable = unavailableRecipient(err);
    if (unavailable) {
      // Nobody can be invited at this profile: nothing went out.
      slot.release();
      claim.release();
      settled();
      return {
        sent: false,
        flags: [inviteRefusedFlag(unavailable.code, unavailable.upstream, unavailable.reason)],
        guard: "linkedin-invite-refused",
      };
    }
    const code = inviteErrorCode(err);
    // Only a code OneShot reports for a failed job proves nothing was sent.
    if (code) {
      slot.release();
      claim.release();
    }
    if (code === "rate_limited" || code === "account_send_limit") {
      settled();
      noteAccountInviteCapReached(input.sender.accountId);
      throw new SendDeferredError(`LinkedIn invites paused for today (${code})`);
    }
    if (code) {
      settled();
      return { sent: false, flags: [`linkedin-${code.replace(/_/g, "-")}`] };
    }
    // Any other failure frees the profile only on proof: the invitation it
    // names reads `not_sent`. Then nothing reached LinkedIn, and no message
    // waits for an acceptance that cannot come.
    const refused = await refusedInviteCode(err, input.sender);
    if (refused) {
      slot.release();
      claim.release();
      settled();
      const { upstream, reason } = linkedInFailure(err);
      return {
        sent: false,
        flags: [inviteRefusedFlag(refused, upstream, reason)],
        guard: "linkedin-invite-refused",
      };
    }
    // A failed job is an outcome too: no longer pending, the claim stays.
    slot.confirm();
    if ((err as { name?: unknown }).name === "JobError") settled();
    throw err;
  }
  const status = result.status;
  if (
    !result.invitation_id ||
    (status !== "sent" && status !== "pending" && status !== "already_connected")
  ) {
    // The call returned, so the invite may have gone out: the claim and the
    // day's slot stay.
    slot.confirm();
    settled();
    throw new Error(`unexpected LinkedIn invite result: ${JSON.stringify(result).slice(0, 160)}`);
  }
  slot.confirm();
  claim.confirm();
  const p = input.row.payload;
  const prospectId =
    input.continuation?.prospectId ??
    ledger.upsertProspect({
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
    stepIndex: input.continuation?.stepIndex ?? 0,
    status: "sent",
    metadata: {
      // subject/body/label: what the cadence timeline and follow-up prompts read.
      subject: "LinkedIn invite",
      body: note,
      label: "connection request",
      note,
      invitationId: result.invitation_id,
      inviteStatus: status,
      ...(input.evidenceClause !== undefined ? { evidenceClause: input.evidenceClause } : {}),
      // The account that sent it: a withdrawal must go to the same one.
      accountId: input.sender.accountId,
      ...(input.sender.workspace ? { accountWorkspace: input.sender.workspace } : {}),
      // The row it went out from: that row's Withdraw acts on this invite only.
      ...(input.row.id > 0 ? { queueId: input.row.id } : {}),
    },
  });
  settled();
  // The LinkedIn sequence: a message once the invite is accepted, then a close.
  // A continuation invite belongs to the email cadence already running. The
  // sequence starts with the row's offer, which its messages make (the note
  // never does), linked to the row.
  if (!input.continuation) {
    const offer = offerOf(input.row.payload);
    enrollInCadence({
      prospectId,
      playName: input.row.playName,
      channel: "linkedin",
      ...(input.row.id > 0 ? { queueId: input.row.id } : {}),
      ...(offer
        ? {
            offer,
            offerCandidates: offerCandidatesOf(input.row.payload),
            offerOrigin: "derived" as const,
          }
        : {}),
    });
  }
  logEvent("linkedin.invite_sent", { play: input.row.playName, status });
  return { sent: true, status, invitationId: result.invitation_id, prospectId };
}

export type KnownConnectionOutcome =
  | { sent: true; status: "already_connected"; prospectId: number }
  | { sent: false; flags: string[]; guard?: LinkedInGuardReason };

/**
 * The sibling of `sendLinkedInInvite` for a known connection
 * (`knownConnection`): the same guard and the same profile claim, but no
 * invite slot and no invite call, since nothing goes to LinkedIn. It records
 * the LinkedIn touch the invite would have, marked `via: "profile-read"` and
 * `already_connected`, so the cadence's first message goes ahead without
 * waiting on an acceptance. Off a queue row it enrolls the LinkedIn sequence
 * with its first message due now; with `continuation` it is the email
 * cadence's connection-request step and enrolls nothing.
 */
export function recordKnownConnection(input: {
  row: LinkedInFirstTouchRow;
  connection: KnownConnection;
  /** The account the first message will go out from. */
  sender: { accountId: string; workspace?: string };
  workspace: string;
  continuation?: { prospectId: number; stepIndex: number };
}): KnownConnectionOutcome {
  const p = input.row.payload;
  const profile = linkedInProfileOf(p);
  const target = normalizeLinkedInProfile(profile);
  const override = p["icpOverride"];
  const verdict = canInviteOnLinkedInNow({
    ...(input.continuation ? { prospectId: input.continuation.prospectId } : {}),
    name: str(p, "name"),
    company: str(p, "company"),
    email: str(p, "email", "founderEmail"),
    linkedinUrl: str(p, "linkedinUrl"),
    icpVerdict: str(p, "icpVerdict"),
    icpOverridden: typeof override === "object" && override !== null,
    ...(!input.continuation ? { firstTouch: true } : {}),
  });
  if (!verdict.ok) return { sent: false, flags: [guardFlag(verdict)], guard: verdict.reason };
  if (!target || !profile) {
    return {
      sent: false,
      flags: ["invalid-profile: the LinkedIn URL is not a personal profile"],
      guard: "invalid-profile",
    };
  }
  // Held like an invite, so no other workspace starts on them; freed again
  // only if LinkedIn says they are not connected (`voidKnownConnection`).
  const claimed = claimLinkedInProfile({
    profile: target,
    workspace: input.workspace,
    as: "connected",
  });
  if (!claimed.ok) return { sent: false, flags: [guardFlag(claimed)], guard: claimed.reason };
  const ledger = getLedger();
  // The record, the prospect and the cadence land together or not at all:
  // nothing went out, so a failed write frees the claim and the row can be
  // sent again without a second record.
  let prospectId: number;
  try {
    prospectId = ledger.inTransaction(() => {
      const id =
        input.continuation?.prospectId ??
        ledger.upsertProspect({
          name: str(p, "name"),
          email: null,
          company: str(p, "company"),
          title: str(p, "title", "currentRole"),
          linkedin_url: profile,
          source: input.row.playName,
          source_profile_url: str(p, "sourceProfileUrl") ?? profile,
        });
      ledger.recordLinkedInInviteEvent({
        prospectId: id,
        playName: input.row.playName,
        stepIndex: input.continuation?.stepIndex ?? 0,
        status: "sent",
        metadata: {
          // What the cadence timeline shows. No `note`: nothing was sent, and
          // the message prompts leave this record out of their prior touches.
          subject: KNOWN_CONNECTION_SUBJECT,
          body: `Already connected on LinkedIn (profile read ${knownConnectionDay(input.connection)}): no connection request sent.`,
          label: "already connected",
          inviteStatus: "already_connected",
          via: KNOWN_CONNECTION_VIA,
          readAt: input.connection.readAt,
          accountId: input.sender.accountId,
          ...(input.sender.workspace ? { accountWorkspace: input.sender.workspace } : {}),
          ...(input.row.id > 0 ? { queueId: input.row.id } : {}),
        },
      });
      if (!input.continuation) {
        const offer = offerOf(p);
        enrollInCadence({
          prospectId: id,
          playName: input.row.playName,
          channel: "linkedin",
          firstStepDueNow: true,
          ...(input.row.id > 0 ? { queueId: input.row.id } : {}),
          ...(offer
            ? {
                offer,
                offerCandidates: offerCandidatesOf(p),
                offerOrigin: "derived" as const,
              }
            : {}),
        });
      }
      return id;
    });
  } catch (err) {
    claimed.claim.release();
    throw err;
  }
  claimed.claim.confirm();
  logEvent("linkedin.known_connection_recorded", { play: input.row.playName });
  return { sent: true, status: "already_connected", prospectId };
}
