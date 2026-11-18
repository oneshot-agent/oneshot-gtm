/**
 * Bridged calls on top of core's `CallBridge` (docs/calls.md). After the call
 * ends, the recording, transcript and suggestion advance one step per read
 * so no request waits on transcription. Nothing here logs an outcome: the
 * member confirms the suggestion through `recordCall`.
 */
import {
  isCallOutcome,
  type CallOutcome,
  type CallRecordView,
  type CallsMeResponse,
  type MemberPhoneView,
} from "@oneshot-gtm/shared-types";
import {
  CallBridgeError,
  answeredByMachine,
  callBridgeFromEnv,
  callsOf,
  defaultPhoneCountry,
  doNotContactMatch,
  doNotContactOf,
  forgetTranscriptionService,
  getLedger,
  getSharedDb,
  isMissingServiceError,
  loadConfig,
  logEvent,
  memberPhoneKey,
  normalizePhone,
  phoneLocalTime,
  resolveTranscriptionService,
  type BridgeCallState,
  type BridgedCall,
  type CallBridge,
  type OneShotConfig,
  type TranscriptLine,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { firstNameFrom } from "./_lib.ts";
import { phoneForCall } from "./_cadence.ts";

/** A verification nobody finished within this is marked failed on the next check. */
export const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** How long after a call ends a recording may take to appear before it counts as none. */
const RECORDING_WAIT_MS = 15 * 60_000;
/** A transcript still pending this long after the call started is given up on. */
export const TRANSCRIPT_GIVE_UP_MS = 6 * 3600_000;
/** How far back the sweep looks for calls with work left, and how many it takes per run. */
const SWEEP_LOOKBACK_MS = 2 * 24 * 3600_000;
const SWEEP_LIMIT = 20;
/** A deletion that failed is tried again after this. */
const DISCARD_RETRY_MS = 15 * 60_000;
/** How long a declined recording that was asked for is looked for before none counts as none. */
const DISCARD_LOOKUP_MS = 7 * 24 * 3600_000;
/** The provider does not transcribe a recording shorter than this. */
const MIN_RECORDING_SEC = 2;
/** Longest transcript text the suggestion reads; a longer call keeps its start and its end. */
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_NOTE_CHARS = 600;
const MAX_COMMITMENTS = 5;
/** The suggestion's model call: past this, a discard waiting on it carries on. */
const SUGGEST_TIMEOUT_MS = 60_000;

const VOICEMAIL = "it went to your voicemail, so nobody was dialled";
const ENDED_BEFORE_DIAL = "the call ended before they were dialled";
const START_UNCERTAIN =
  "Twilio did not confirm the call in time, so your phone may still ring; check it before calling again";
const KEYS_MISSING =
  "bridged calls need the Twilio keys (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET) in this workspace's .env";

/** A request the bridge refuses; the route answers with its status and message. */
export class CallBridgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = "CallBridgeRequestError";
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

function bridgeFor(opts: { bridge?: CallBridge | null }): CallBridge | null {
  return opts.bridge !== undefined ? opts.bridge : callBridgeFromEnv();
}

function providerError(err: unknown): CallBridgeRequestError {
  const message = (err as Error).message ?? "the call provider failed";
  return new CallBridgeRequestError(message, 502);
}

const NO_PHONE: MemberPhoneView = {
  phone: null,
  status: "none",
  validationCode: null,
  verifiedAt: null,
  error: null,
};

/** A member's phone as the dashboard shows it. `email` null = the unlisted local owner. */
export function memberPhoneView(email: string | null): MemberPhoneView {
  const row = getSharedDb().memberPhone(memberPhoneKey(email));
  if (!row) return { ...NO_PHONE };
  return {
    phone: row.phone,
    status: row.status,
    validationCode: row.status === "verifying" ? row.validation_code : null,
    verifiedAt: row.verified_at,
    error: row.error,
  };
}

/** The member's verified phone, E.164, or null. */
function verifiedPhone(email: string | null): string | null {
  const row = getSharedDb().memberPhone(memberPhoneKey(email));
  return row?.status === "verified" ? row.phone : null;
}

/** GET /api/calls/me: whether this member's Call button can ring their phone. */
export function callsMe(
  email: string | null,
  opts: { bridge?: CallBridge | null } = {},
): CallsMeResponse {
  const calls = callsOf(loadConfig());
  return {
    bridgeReady: calls.bridge != null && bridgeFor(opts) != null,
    phone: memberPhoneView(email),
    record: calls.bridge?.record ?? false,
  };
}

/** True when this member's Call rings their phone: the keys are set and their phone is verified. */
export function memberCanBridge(
  email: string | null,
  opts: { bridge?: CallBridge | null } = {},
): boolean {
  const me = callsMe(email, opts);
  return me.bridgeReady && me.phone.status === "verified";
}

/**
 * Start verifying a member's phone as a caller ID: the provider rings it and
 * the view carries the code to type. Caller IDs belong to the whole account,
 * so one it lists already proves nothing about this member: it is removed
 * and verified again with a fresh code. Only this member's own code, typed
 * on a call to the phone, marks it verified. A provider refusal is stored as
 * a failed verification (and thrown, 502).
 */
export async function verifyMemberPhone(
  email: string | null,
  raw: string,
  opts: { bridge?: CallBridge | null } = {},
): Promise<MemberPhoneView> {
  const cfg = loadConfig();
  const phone = normalizePhone(raw, defaultPhoneCountry(cfg));
  if (!phone)
    throw new CallBridgeRequestError(
      "that is not a phone number that can be called; include the country code",
      400,
    );
  if (callsOf(cfg).bridge == null)
    throw new CallBridgeRequestError("bridged calls are off for this workspace", 409);
  const bridge = bridgeFor(opts);
  if (!bridge) throw new CallBridgeRequestError(KEYS_MISSING, 409);
  const shared = getSharedDb();
  const member = memberPhoneKey(email);
  // A caller ID verified for one member must never be claimable by another without a code.
  if (heldByAnother(member, phone))
    throw new CallBridgeRequestError("that number is another member's phone", 409);
  const own = shared.memberPhone(member);
  if (own?.phone === phone && own.status === "verified") return memberPhoneView(email);
  try {
    const listed = await bridge.isVerified(phone);
    // This member's own code was typed: the challenge they started is done.
    if (listed && own?.phone === phone && own.status === "verifying") {
      shared.setMemberPhone({
        member,
        phone,
        status: "verified",
        verifiedAt: new Date().toISOString(),
      });
      return memberPhoneView(email);
    }
    if (listed) await bridge.removeCallerId(phone);
    const { validationCode } = await bridge.verifyCallerId(phone);
    shared.setMemberPhone({ member, phone, status: "verifying", validationCode });
  } catch (err) {
    shared.setMemberPhone({ member, phone, status: "failed", error: (err as Error).message });
    throw providerError(err);
  }
  logEvent("call.phone_verify_started", { member_set: email != null });
  return memberPhoneView(email);
}

/**
 * Check a verification: verified once the provider lists the number; failed
 * when nobody typed the code within `VERIFY_TIMEOUT_MS`; else still verifying.
 */
export async function checkMemberPhone(
  email: string | null,
  opts: { bridge?: CallBridge | null; now?: Date } = {},
): Promise<MemberPhoneView> {
  const shared = getSharedDb();
  const member = memberPhoneKey(email);
  const row = shared.memberPhone(member);
  if (!row) throw new CallBridgeRequestError("no phone to check; add yours first", 409);
  if (row.status === "verified") return memberPhoneView(email);
  const bridge = bridgeFor(opts);
  if (!bridge) throw new CallBridgeRequestError(KEYS_MISSING, 409);
  const now = opts.now ?? new Date();
  let listed: boolean;
  try {
    listed = await bridge.isVerified(row.phone);
  } catch (err) {
    throw providerError(err);
  }
  // Only this member's own pending challenge: a failed row waits for a fresh Verify.
  if (listed && row.status === "verifying") {
    shared.setMemberPhone({
      member,
      phone: row.phone,
      status: "verified",
      verifiedAt: now.toISOString(),
    });
  } else if (
    !listed &&
    row.status === "verifying" &&
    now.getTime() - Date.parse(row.updated_at) > VERIFY_TIMEOUT_MS
  ) {
    shared.setMemberPhone({
      member,
      phone: row.phone,
      status: "failed",
      error: "the code was not entered in time; press Verify again",
    });
  }
  return memberPhoneView(email);
}

function heldByAnother(member: string, phone: string): boolean {
  const shared = getSharedDb();
  return shared
    .memberPhoneHolders(phone)
    .some((m) => m !== member && (m === "" || shared.activeMember(m) != null));
}

/**
 * Forget a member's phone and remove it as a caller ID, so using it again
 * needs a fresh code. A phone stored while the provider was removing the
 * old one is kept.
 */
export async function removeMemberPhone(
  email: string | null,
  opts: { bridge?: CallBridge | null } = {},
): Promise<MemberPhoneView> {
  const shared = getSharedDb();
  const member = memberPhoneKey(email);
  const row = shared.memberPhone(member);
  if (!row) return { ...NO_PHONE };
  if (!heldByAnother(member, row.phone)) {
    const bridge = bridgeFor(opts);
    if (!bridge) throw new CallBridgeRequestError(KEYS_MISSING, 409);
    try {
      await bridge.removeCallerId(row.phone);
    } catch (err) {
      throw providerError(err);
    }
  }
  if (!shared.deleteMemberPhone(member, row)) return memberPhoneView(email);
  return { ...NO_PHONE };
}

/** What the member hears when they pick up: "Calling Dana at Acme". */
function sayNameOf(name: string | null, company: string | null): string | null {
  const first = firstNameFrom(name);
  const who = first ?? (name?.trim() || null);
  const at = company?.trim() || null;
  if (who && at) return `${who} at ${at}`;
  return who ?? at;
}

function companyBlocked(cfg: OneShotConfig, prospectId: number, email: string | null): boolean {
  const dnc = doNotContactOf(cfg);
  if (dnc.domains.length === 0 && dnc.companies.length === 0) return false;
  return doNotContactMatch(getLedger().contactIdentityFor({ prospectId, email }), dnc) != null;
}

/** "14:05" from an ISO time in the prospect's first zone; the ISO time itself when unknown. */
function opensAtText(opensAt: string | null, zone: string | undefined): string {
  if (!opensAt) return "later";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(opensAt));
  } catch {
    return opensAt;
  }
}

/**
 * Why the prospect may no longer be dialled, rechecked as the member's phone
 * picks up (an opt-out or the window closing while it rang); null when they
 * may.
 */
function dialRefusal(prospectId: number, phone: string, now: Date): string | null {
  const cfg = loadConfig();
  const calls = callsOf(cfg);
  const ledger = getLedger();
  const prospect = ledger.getProspectById(prospectId);
  if (!calls.bridge) return "bridged calls were turned off, so nobody was dialled";
  if (
    !calls.enabled ||
    !prospect ||
    !ledger.callAllowed(prospectId) ||
    companyBlocked(cfg, prospectId, prospect.email ?? null)
  )
    return "contact with them is no longer allowed, so nobody was dialled";
  if (!phoneLocalTime(phone, calls.window, now).inWindow)
    return "their call hours closed while your phone rang, so nobody was dialled";
  return null;
}

/**
 * Place a bridged call behind the same gates as the Calls page (each refusal
 * a 409 with a plain message). The `calls` row is written only once the
 * provider took the call, so a refused call leaves no trace.
 */
export async function startBridgedCall(input: {
  prospectId: number;
  playName?: string | null;
  /** The member placing it (email); null for the unlisted local owner. */
  member: string | null;
  now?: Date;
  bridge?: CallBridge | null;
}): Promise<CallRecordView> {
  const now = input.now ?? new Date();
  const cfg = loadConfig();
  const calls = callsOf(cfg);
  if (!calls.enabled) throw new CallBridgeRequestError("calls are off for this workspace", 409);
  if (!calls.bridge)
    throw new CallBridgeRequestError("bridged calls are off for this workspace", 409);
  const bridge = bridgeFor(input);
  if (!bridge) throw new CallBridgeRequestError(KEYS_MISSING, 409);
  const memberPhone = verifiedPhone(input.member);
  if (!memberPhone)
    throw new CallBridgeRequestError("verify your phone in Setup → Calls before calling", 409);
  const ledger = getLedger();
  const prospect = ledger.getProspectById(input.prospectId);
  if (!prospect) throw new CallBridgeRequestError("prospect not found", 404);
  if (
    !ledger.callAllowed(input.prospectId) ||
    companyBlocked(cfg, input.prospectId, prospect.email ?? null)
  )
    throw new CallBridgeRequestError("contact with this person is not allowed", 409);
  const number = phoneForCall(input.prospectId, cfg).phone;
  if (!number) throw new CallBridgeRequestError("no usable number for this person", 409);
  if (number === memberPhone) throw new CallBridgeRequestError("that is your own number", 409);
  const local = phoneLocalTime(number, calls.window, now);
  if (!local.inWindow)
    throw new CallBridgeRequestError(
      `outside their call hours: it is ${local.localTime ?? "outside the window"} there; calls open ${opensAtText(local.opensAt, local.zones[0])} their time`,
      409,
    );
  const row = {
    prospectId: input.prospectId,
    playName: input.playName?.trim() || null,
    startedAt: now.toISOString(),
    phone: number,
    provider: "twilio" as const,
    member: input.member,
    memberPhone,
    // "ask" records nothing until the member presses Record.
    transcriptStatus: calls.bridge.record === "always" ? ("pending" as const) : ("none" as const),
  };
  let callSid: string;
  try {
    ({ callSid } = await bridge.start({
      memberPhone,
      sayName: sayNameOf(prospect.name ?? null, prospect.company ?? null),
    }));
  } catch (err) {
    // Never retried: a second try could ring the member twice.
    if (err instanceof CallBridgeError && err.uncertain) {
      ledger.insertCall({
        ...row,
        status: "failed",
        statusReason: START_UNCERTAIN,
        transcriptStatus: "none",
      });
      throw new CallBridgeRequestError(START_UNCERTAIN, 502);
    }
    throw providerError(err);
  }
  let id: number;
  try {
    id = ledger.insertCall({ ...row, providerCallSid: callSid, status: "ringing_founder" });
  } catch (err) {
    // A call nothing tracks would bridge nobody; end it, or leave its SID where it can be found.
    await bridge
      .hangUp(callSid)
      .catch((hangErr: unknown) =>
        logEvent(
          "call.untracked",
          { call_sid: callSid, message_120: ((hangErr as Error).message ?? "").slice(0, 120) },
          "error",
        ),
      );
    throw err;
  }
  logEvent("call.started", {
    prospect_id: input.prospectId,
    record: String(calls.bridge.record),
  });
  return ledger.getCall(id)!;
}

/**
 * Whether `actor` may act on a bridged call: hanging up and recording are
 * the placing member's alone (recording waits on their own consent); an
 * owner may also delete its recording. A call the unlisted local owner
 * placed belongs to every owner. Refusal is a 403, before anything is done.
 */
export function assertCallActor(
  callId: number,
  actor: { email: string | null; role: "owner" | "member" },
  action: "hangup" | "record" | "discard",
): void {
  const call = getLedger().getCall(callId);
  if (!call || call.provider !== "twilio")
    throw new CallBridgeRequestError("bridged call not found", 404);
  const placedBy = call.member == null ? null : memberPhoneKey(call.member);
  const own = placedBy === (actor.email == null ? null : memberPhoneKey(actor.email));
  const owner = actor.role === "owner";
  if (own || (owner && (placedBy == null || action === "discard"))) return;
  throw new CallBridgeRequestError(
    action === "discard"
      ? "only the member who placed this call, or an owner, can delete its recording"
      : `only the member who placed this call can ${action === "record" ? "record" : "hang up"} it`,
    403,
  );
}

/** Hang up a bridged call (ringing or connected), then read its state. */
export async function hangUpBridgedCall(
  callId: number,
  opts: { bridge?: CallBridge | null } = {},
): Promise<CallRecordView> {
  const call = getLedger().getBridgedCall(callId);
  if (!call) throw new CallBridgeRequestError("bridged call not found", 404);
  const bridge = bridgeFor(opts);
  if (!bridge) throw new CallBridgeRequestError(KEYS_MISSING, 409);
  try {
    await bridge.hangUp(call.callSid);
  } catch (err) {
    throw providerError(err);
  }
  return refreshBridgedCall(callId, { bridge });
}

const TERMINAL = new Set(["ended", "failed"]);

/** Work in flight per call, so overlapping reads never advance one call twice. */
const inFlight = new Map<number, Promise<void>>();

/** Tests: wait for every background advance started by `refreshBridgedCall`. */
export async function settleBridgedCallWork(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled(inFlight.values());
}

/**
 * A call with its live state: while it rings or talks, read from the
 * provider and stored; once over, the recording, transcript and suggestion
 * are advanced one step, in the background unless `wait`, so the dial
 * panel's poll returns at once and picks the result up on a later read. A
 * `tel:` call, or no bridge, is returned as stored.
 */
export async function refreshBridgedCall(
  callId: number,
  opts: { bridge?: CallBridge | null; now?: Date; wait?: boolean } = {},
): Promise<CallRecordView> {
  const ledger = getLedger();
  const call = ledger.getBridgedCall(callId);
  if (!call) {
    const view = ledger.getCall(callId);
    if (!view) throw new CallBridgeRequestError("call not found", 404);
    return view;
  }
  const bridge = bridgeFor(opts);
  if (!bridge) return call.view;
  const now = opts.now ?? new Date();
  if (!TERMINAL.has(call.view.status ?? "")) {
    try {
      const state = await bridge.status(call.callSid);
      // The prospect declined recording and the hang-up did not get through: again.
      if (call.discardPending && !TERMINAL.has(state.status))
        await bridge
          .hangUp(call.callSid)
          .catch((err: unknown) =>
            logEvent(
              "call.discard_hangup_failed",
              { call_id: callId, message_120: ((err as Error).message ?? "").slice(0, 120) },
              "warn",
            ),
          );
      // Read after the status request: the window may have closed while it ran.
      if (!call.bridgedAt) await holdStep(call, state, bridge, opts.now ?? new Date());
      else
        ledger.updateBridgedCall(callId, {
          status: state.status,
          ...(state.durationSec != null ? { durationSec: state.durationSec } : {}),
          // The prospect never answered: nothing was recorded.
          ...(TERMINAL.has(state.status) &&
          !state.answered &&
          call.view.transcriptStatus === "pending"
            ? { transcriptStatus: "none" as const }
            : {}),
        });
    } catch (err) {
      // A call the provider no longer has will never move again.
      if (err instanceof CallBridgeError && err.status === 404)
        ledger.updateBridgedCall(callId, { status: "failed" });
      logEvent(
        "call.status_failed",
        { call_id: callId, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }
  }
  const fresh = ledger.getBridgedCall(callId)!;
  if (
    TERMINAL.has(fresh.view.status ?? "") &&
    (fresh.discardPending || hasTranscriptWork(fresh.view))
  ) {
    const work = inFlight.get(callId) ?? startAdvance(callId, bridge, now);
    if (opts.wait) await work;
  }
  return ledger.getCall(callId)!;
}

/**
 * The member's leg before anyone else is dialled: a human (or an undecided
 * detection) gets the prospect dialled, a voicemail or fax gets hung up.
 * `claimBridge` lets exactly one of two overlapping polls act on it.
 */
async function holdStep(
  call: BridgedCall,
  state: BridgeCallState,
  bridge: CallBridge,
  now: Date,
): Promise<void> {
  const ledger = getLedger();
  const id = call.view.id;
  if (TERMINAL.has(state.status)) {
    ledger.updateBridgedCall(id, {
      status: state.status,
      statusReason: state.status === "failed" ? "your phone did not answer" : ENDED_BEFORE_DIAL,
      transcriptStatus: "none",
    });
    return;
  }
  if (state.answeredBy == null) {
    ledger.updateBridgedCall(id, { status: "ringing_founder" });
    return;
  }
  // Another poll owns the call now, and may have moved it on already.
  if (!ledger.claimBridge(id, now.toISOString())) return;
  const fail = async (reason: string) => {
    await bridge.hangUp(call.callSid).catch(() => {});
    ledger.updateBridgedCall(id, {
      status: "failed",
      statusReason: reason,
      transcriptStatus: "none",
      recordingFrom: null,
      recordingRequestedAt: null,
    });
  };
  if (answeredByMachine(state.answeredBy)) return fail(VOICEMAIL);
  if (!call.memberPhone || !call.phone) return fail("the call is missing a number");
  const refusal = dialRefusal(call.view.prospectId, call.phone, now);
  if (refusal) return fail(refusal);
  // The mode as it is now, not when the call was placed; a declined one never records.
  const record = callsOf(loadConfig()).bridge?.record === "always" && !call.discardPending;
  ledger.updateBridgedCall(
    id,
    record
      ? {
          transcriptStatus: "pending",
          recordingFrom: "answer",
          recordingRequestedAt: now.toISOString(),
        }
      : { transcriptStatus: "none" },
  );
  try {
    await bridge.connect(call.callSid, {
      memberPhone: call.memberPhone,
      prospectPhone: call.phone,
      record,
    });
  } catch (err) {
    // Unknown outcome: the next read sees the prospect's leg, or the hold running out.
    if (!(err instanceof CallBridgeError && err.uncertain))
      return fail(`could not dial them: ${(err as Error).message}`);
  }
  ledger.updateBridgedCall(id, { status: "ringing_prospect" });
}

function hasTranscriptWork(view: CallRecordView): boolean {
  return (
    view.transcriptStatus === "pending" ||
    (view.transcriptStatus === "ready" && view.suggestion == null && !!view.transcript?.length)
  );
}

function startAdvance(callId: number, bridge: CallBridge, now: Date): Promise<void> {
  const work = (
    getLedger().getBridgedCall(callId)?.discardPending
      ? advanceDiscard(callId, bridge, now)
      : advanceTranscript(callId, bridge, now)
  )
    .catch((err) =>
      logEvent(
        "call.transcript_failed",
        { call_id: callId, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      ),
    )
    .finally(() => inFlight.delete(callId));
  inFlight.set(callId, work);
  return work;
}

/**
 * One step after the call: find the recording (none once the call is well
 * over without one, or one too short to transcribe), ask for its
 * transcript, read the transcript once complete, then write the suggested
 * outcome. A failed transcript is marked failed.
 */
async function advanceTranscript(callId: number, bridge: CallBridge, now: Date): Promise<void> {
  const ledger = getLedger();
  let call: BridgedCall = ledger.getBridgedCall(callId)!;
  if (call.view.transcriptStatus === "pending" && !call.recordingSid) {
    const rec = await bridge.recording(call.callSid);
    const endedAt =
      Date.parse(call.view.startedAt) + (call.view.durationSec ?? 0) * 1000 + RECORDING_WAIT_MS;
    if (!rec) {
      if (now.getTime() > endedAt) ledger.updateBridgedCall(callId, { transcriptStatus: "none" });
      return;
    }
    if (rec.status === "absent" || rec.status === "deleted") {
      ledger.updateBridgedCall(callId, { transcriptStatus: "none" });
      return;
    }
    if (rec.status !== "completed") return;
    if (rec.durationSec != null && rec.durationSec < MIN_RECORDING_SEC) {
      ledger.updateBridgedCall(callId, { recordingSid: rec.sid, transcriptStatus: "none" });
      return;
    }
    ledger.updateBridgedCall(callId, { recordingSid: rec.sid });
    call = ledger.getBridgedCall(callId)!;
  }
  if (call.view.transcriptStatus === "pending" && call.recordingSid && !call.transcriptSid) {
    const transcriptSid = await requestTranscript(callId, call.recordingSid, bridge);
    if (!transcriptSid) return;
    ledger.updateBridgedCall(callId, { transcriptSid });
    call = ledger.getBridgedCall(callId)!;
  }
  if (call.view.transcriptStatus === "pending" && call.transcriptSid) {
    const t = await bridge.transcript(call.transcriptSid);
    if (t.status === "failed") ledger.updateBridgedCall(callId, { transcriptStatus: "failed" });
    if (t.status !== "ready") return;
    ledger.updateBridgedCall(callId, { transcript: t.lines ?? [], transcriptStatus: "ready" });
    call = ledger.getBridgedCall(callId)!;
  }
  if (
    call.view.transcriptStatus === "ready" &&
    call.view.suggestion == null &&
    call.view.transcript?.length
  ) {
    const prospect = ledger.getProspectById(call.view.prospectId);
    const suggestion = await suggestCallOutcome({
      transcript: call.view.transcript,
      prospectName: prospect?.name ?? null,
      company: prospect?.company ?? null,
      cfg: loadConfig(),
    });
    ledger.updateBridgedCall(callId, { suggestion });
    logEvent("call.suggested", { call_id: callId, outcome: suggestion.outcome });
  }
}

/**
 * Ask the provider for a transcript, unless the prospect declined recording
 * while the service was looked up (null). A kept service the provider no
 * longer has is forgotten and replaced once.
 */
async function requestTranscript(
  callId: number,
  recordingSid: string,
  bridge: CallBridge,
): Promise<string | null> {
  const configured = callsOf(loadConfig()).bridge?.transcriptionServiceSid ?? null;
  const declined = () => {
    const now = getLedger().getBridgedCall(callId);
    return !now || now.discardPending || now.view.transcriptStatus !== "pending";
  };
  let serviceSid = await resolveTranscriptionService(bridge, configured);
  if (declined()) return null;
  try {
    return (await bridge.transcribe({ recordingSid, serviceSid })).transcriptSid;
  } catch (err) {
    if (configured || !isMissingServiceError(err)) throw err;
    forgetTranscriptionService(serviceSid);
    serviceSid = await resolveTranscriptionService(bridge, null);
    if (declined()) return null;
    return (await bridge.transcribe({ recordingSid, serviceSid })).transcriptSid;
  }
}

/**
 * The prospect agreed to recording (the "ask" mode): record the connected
 * call from now, both sides on their own channel. Pressing it twice records
 * once; a call already recorded, or whose recording was declined, is
 * returned as it is.
 */
export async function startBridgedRecording(
  callId: number,
  opts: { bridge?: CallBridge | null } = {},
): Promise<CallRecordView> {
  const ledger = getLedger();
  const call = ledger.getBridgedCall(callId);
  if (!call) throw new CallBridgeRequestError("bridged call not found", 404);
  if (!callsOf(loadConfig()).bridge?.record)
    throw new CallBridgeRequestError("recording is off for this workspace", 409);
  if (call.view.transcriptStatus !== "none" || call.discardPending) return call.view;
  const bridge = bridgeFor(opts);
  if (!bridge) throw new CallBridgeRequestError(KEYS_MISSING, 409);
  let state: BridgeCallState;
  try {
    state = await bridge.status(call.callSid);
  } catch (err) {
    throw providerError(err);
  }
  if (state.status !== "connected")
    throw new CallBridgeRequestError("Record works only while you are connected to them", 409);
  // Again after the status request: recording may have been turned off while it ran.
  if (!callsOf(loadConfig()).bridge?.record)
    throw new CallBridgeRequestError("recording is off for this workspace", 409);
  if (!ledger.claimRecording(callId, new Date().toISOString())) return ledger.getCall(callId)!;
  try {
    await bridge.startRecording(call.callSid);
  } catch (err) {
    // Unknown outcome: the transcript step finds a recording, or gives up on none.
    if (err instanceof CallBridgeError && err.uncertain)
      throw new CallBridgeRequestError(
        "Twilio did not confirm the recording started; it may be recording",
        502,
      );
    ledger.releaseRecording(callId);
    throw providerError(err);
  }
  logEvent("call.recording_started", { call_id: callId });
  return ledger.getCall(callId)!;
}

/**
 * The prospect declined recording: hang up if the call is still live, drop
 * the transcript, suggestion and promises at once, then delete the
 * provider's transcripts and recording (now, or on a later read or sweep
 * while the recording is still processing). Separate from logging an
 * outcome; the flag is stored first, so the sweep finishes what fails here.
 */
export async function discardBridgedRecording(
  callId: number,
  opts: { bridge?: CallBridge | null; now?: Date } = {},
): Promise<CallRecordView> {
  const ledger = getLedger();
  const call = ledger.getBridgedCall(callId);
  if (!call) throw new CallBridgeRequestError("bridged call not found", 404);
  ledger.markRecordingDiscard(callId);
  const bridge = bridgeFor(opts);
  if (!bridge) return ledger.getCall(callId)!;
  // A failed hang-up is retried by every later read while the call is live.
  if (!TERMINAL.has(call.view.status ?? "")) await bridge.hangUp(call.callSid).catch(() => {});
  await inFlight.get(callId);
  await refreshBridgedCall(callId, { bridge, ...(opts.now ? { now: opts.now } : {}), wait: true });
  return ledger.getCall(callId)!;
}

async function advanceDiscard(callId: number, bridge: CallBridge, now: Date): Promise<void> {
  try {
    await discardStep(callId, bridge, now);
  } catch (err) {
    // Behind the deletions that can run now, so one failing never holds them up.
    getLedger().deferDiscard(callId, new Date(now.getTime() + DISCARD_RETRY_MS).toISOString());
    throw err;
  }
}

async function discardStep(callId: number, bridge: CallBridge, now: Date): Promise<void> {
  const ledger = getLedger();
  const call = ledger.getBridgedCall(callId)!;
  const rec = call.recordingSid
    ? { sid: call.recordingSid, status: "completed" }
    : await bridge.recording(call.callSid);
  if (!rec) {
    const ended = Date.parse(call.view.startedAt) + (call.view.durationSec ?? 0) * 1000;
    if (now.getTime() <= ended + RECORDING_WAIT_MS) return;
    // A recording that was asked for may surface late: keep looking, hourly, for a week.
    if (call.view.recordedFrom && now.getTime() <= ended + DISCARD_LOOKUP_MS) {
      ledger.deferDiscard(callId, new Date(now.getTime() + 3600_000).toISOString());
      return;
    }
    ledger.finishRecordingDiscard(callId);
    return;
  }
  const transcripts = new Set(await bridge.transcriptsFor(rec.sid));
  if (call.transcriptSid) transcripts.add(call.transcriptSid);
  for (const sid of transcripts) await bridge.deleteTranscript(sid);
  // Only a completed recording can be deleted: a processing one waits for the next read.
  if (rec.status === "absent" || rec.status === "deleted") {
    ledger.finishRecordingDiscard(callId);
    return;
  }
  if (rec.status !== "completed") return;
  await bridge.deleteRecording(rec.sid);
  ledger.finishRecordingDiscard(callId);
  logEvent("call.recording_discarded", { call_id: callId });
}

/** The scheduler's sweep: finishes bridged calls whose tab closed, and gives up on stale transcripts. */
export async function sweepBridgedCalls(
  opts: { bridge?: CallBridge | null; now?: Date } = {},
): Promise<{ checked: number; gaveUp: number }> {
  const calls = callsOf(loadConfig());
  if (!calls.bridge) return { checked: 0, gaveUp: 0 };
  const bridge = bridgeFor(opts);
  if (!bridge) return { checked: 0, gaveUp: 0 };
  const now = opts.now ?? new Date();
  const ledger = getLedger();
  // With Calls off, only declined recordings are still worked: they must not stay on the provider.
  const gaveUp = calls.enabled
    ? ledger.failStaleTranscripts(new Date(now.getTime() - TRANSCRIPT_GIVE_UP_MS).toISOString())
    : 0;
  const rows = ledger.listBridgedCallsToAdvance(
    new Date(now.getTime() - SWEEP_LOOKBACK_MS).toISOString(),
    SWEEP_LIMIT,
    undefined,
    now.toISOString(),
    !calls.enabled,
  );
  for (const row of rows) {
    try {
      await refreshBridgedCall(row.view.id, { bridge, now, wait: true });
    } catch (err) {
      logEvent(
        "call.sweep_failed",
        { call_id: row.view.id, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }
  }
  return { checked: rows.length, gaveUp };
}

/** "m:ss" from seconds. */
function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The transcript as the prompt reads it, its middle left out past `MAX_TRANSCRIPT_CHARS`. */
export function transcriptText(lines: readonly TranscriptLine[]): string {
  const text = lines
    .map(
      (l) => `[${clock(l.startSec)}] ${l.speaker === "founder" ? "CALLER" : "PROSPECT"}: ${l.text}`,
    )
    .join("\n");
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  const head = Math.floor(MAX_TRANSCRIPT_CHARS / 4);
  return `${text.slice(0, head)}\n[… the middle of the call is left out …]\n${text.slice(text.length - (MAX_TRANSCRIPT_CHARS - head))}`;
}

/**
 * The model's proposal, made safe: an outcome from `CALL_OUTCOMES` (else
 * no_answer when the prospect said nothing, not_now when they did), a short
 * note, and at most five promises.
 */
export function parseCallOutcome(
  content: string,
  fallback: { prospectSpoke: boolean },
): NonNullable<CallRecordView["suggestion"]> {
  const value: unknown = tryParseJsonObject<unknown>(content, {});
  // `null`, an array or a scalar parses too: anything but an object is the fallback.
  const parsed: Record<string, unknown> =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const raw = parsed["outcome"];
  const outcome: CallOutcome = isCallOutcome(raw)
    ? raw
    : fallback.prospectSpoke
      ? "not_now"
      : "no_answer";
  const commitments = (Array.isArray(parsed["commitments"]) ? parsed["commitments"] : [])
    .map((c) => str(c).slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_COMMITMENTS);
  return { outcome, note: str(parsed["note"]).slice(0, MAX_NOTE_CHARS), commitments };
}

/**
 * Suggest the outcome of a call from its transcript: one paid completion on
 * the workspace's configured model. The member confirms or changes it; it is
 * never logged on its own.
 */
export async function suggestCallOutcome(input: {
  transcript: readonly TranscriptLine[];
  prospectName: string | null;
  company: string | null;
  cfg: OneShotConfig;
}): Promise<NonNullable<CallRecordView["suggestion"]>> {
  const user = [
    `CALLER: ${input.cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${input.cfg.productOneLiner ?? "(unknown)"}`,
    `PROSPECT: ${input.prospectName ?? "(unknown)"}`,
    `COMPANY: ${input.company ?? "(unknown)"}`,
    "",
    "TRANSCRIPT:",
    transcriptText(input.transcript),
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("call-outcome") },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: 400,
    timeoutMs: SUGGEST_TIMEOUT_MS,
  });
  return parseCallOutcome(res.content, {
    prospectSpoke: input.transcript.some((l) => l.speaker === "prospect"),
  });
}
