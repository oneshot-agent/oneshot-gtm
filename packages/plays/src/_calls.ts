/**
 * The dialler: the founder calls prospects from the dashboard. Three parts
 * live here, on top of the call step in `_cadence.ts`:
 *
 *   - the call brief (`buildCallBrief`), written by the preview of a due call
 *     step or on demand for anyone else on the Calls page (`callBriefFor`);
 *   - logging an outcome (`recordCall`), which moves or stops cadences the way
 *     a sent step or a reply does;
 *   - the Calls page's lists (`listCalls`).
 *
 * Off unless `calls.enabled`. Nothing here dials: phase 1 is a `tel:` link.
 */
import { createHash } from "node:crypto";
import {
  CALL_OUTCOMES,
  type CallBrief,
  type CallListResponse,
  type CallListRow,
  type CallOutcome,
  type CallRecordView,
  type LogCallRequest,
} from "@oneshot-gtm/shared-types";
import {
  CALL_REPLY_OUTCOMES,
  angleBlockFromJson,
  callsOf,
  defaultPhoneCountry,
  doNotContactMatch,
  doNotContactOf,
  getLedger,
  loadConfig,
  logEvent,
  normalizePhone,
  phoneLocalTime,
  pickCallPhone,
  productBriefText,
  type CallCandidate,
  type OneShotConfig,
  type ProspectRecord,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { firstNameFrom, lintEmail, voiceBlock } from "./_lib.ts";
import { offerBlock } from "./_prospect-offer.ts";
import type { SequenceOfferValue } from "./_sequence-offer.ts";
import {
  callStepIsNext,
  completeCallStep,
  getPriorStepsForProspect,
  nextStepInfo,
  phoneForCall,
  previewCadenceStep,
  prospectContextLines,
  sequenceOffer,
  stopCadencesForOptOut,
  type CadenceContext,
  type PriorStepRow,
  type StepPayload,
} from "./_cadence.ts";

/** About 20 seconds spoken. */
const VOICEMAIL_MAX_WORDS = 55;

/** Most rows the Calls page's call list shows. */
export const CALL_LIST_LIMIT = 200;

/** Ranked candidates read per page while filling the call list, and at most this many pages. */
const CALL_CANDIDATE_PAGE = 400;
const CALL_CANDIDATE_PAGES = 5;

/** Days a `not_now` holds the cadence when the founder picks no date. */
const NOT_NOW_DEFAULT_DAYS = 14;

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** The text without its trailing dots and spaces. A scan, not a regex: the input is config text (CodeQL: polynomial backtracking). */
function trimEndDots(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "." || /\s/.test(text[end - 1]!))) end--;
  return text.slice(0, end);
}

/** A short fingerprint of the offer a brief restates; null for none. */
function offerKeyOf(offer: SequenceOfferValue | null): string | null {
  if (!offer?.offer) return null;
  return createHash("sha256")
    .update(`${offer.offer}\n${offer.steps ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/** The brief as one block of text: the stored preview's body, and what the lint reads. */
export function callBriefText(brief: CallBrief): string {
  return [
    `Opener: ${brief.opener}`,
    `Offer: ${brief.offer}`,
    ...(brief.questions.length > 0 ? ["Questions:", ...brief.questions.map((q) => `- ${q}`)] : []),
    ...(brief.objections.length > 0
      ? ["Objections:", ...brief.objections.map((o) => `- ${o.objection} → ${o.answer}`)]
      : []),
    `Voicemail: ${brief.voicemail}`,
    ...(brief.gatekeeper ? [`Gatekeeper: ${brief.gatekeeper}`] : []),
  ].join("\n");
}

/** A one-line read of the angle's hook, for the fallback offer. */
function angleHook(angleJson: string | null | undefined): string {
  try {
    const a = JSON.parse(angleJson ?? "") as { hook?: unknown } | null;
    return str(a?.hook);
  } catch {
    return "";
  }
}

/**
 * Turn the model's JSON into a brief, filling what is missing from the
 * inputs so the founder always has something honest to read: the offer from
 * the sequence, the angle or the product line; a plain opener and voicemail;
 * no questions or objections rather than invented ones.
 */
export function parseCallBrief(
  content: string,
  fallback: {
    firstName: string | null;
    fullName: string | null;
    founderName: string | null;
    product: string | null;
    offer: string | null;
    angle: string | null;
    emailed: boolean;
  },
): CallBrief {
  const parsed = tryParseJsonObject<Record<string, unknown>>(content, {});
  const hi = fallback.firstName ? `Hi ${fallback.firstName}` : "Hi";
  const who = fallback.founderName ? `this is ${fallback.founderName}` : "I'm the founder";
  const offer =
    str(parsed["offer"]) ||
    str(fallback.offer) ||
    str(fallback.angle) ||
    (fallback.product ? `${trimEndDots(fallback.product)}.` : "");
  const opener =
    str(parsed["opener"]) ||
    `${hi}, ${who}. ${
      fallback.emailed
        ? "I emailed you recently and wanted to follow up by phone."
        : "This is a cold call, so I'll be quick."
    } Do you have a minute?`;
  const questions = (Array.isArray(parsed["questions"]) ? parsed["questions"] : [])
    .map(str)
    .filter(Boolean)
    .slice(0, 3);
  const objections = (Array.isArray(parsed["objections"]) ? parsed["objections"] : [])
    .map((o) =>
      o && typeof o === "object"
        ? {
            objection: str((o as Record<string, unknown>)["objection"]),
            answer: str((o as Record<string, unknown>)["answer"]),
          }
        : null,
    )
    .filter((o): o is { objection: string; answer: string } => !!o?.objection && !!o.answer)
    .slice(0, 4);
  const voicemail =
    str(parsed["voicemail"]) ||
    `${hi}, ${who}.${offer ? ` ${offer}` : ""} I'll follow up by email.`;
  const gatekeeperRaw = parsed["gatekeeper"];
  const gatekeeper =
    gatekeeperRaw === null
      ? null
      : str(gatekeeperRaw) ||
        (fallback.fullName ? `Could you put me through to ${fallback.fullName}, please?` : null);
  return { opener, offer, questions, objections, voicemail, gatekeeper };
}

/**
 * Advisory writing flags on a brief: the email lint over its text (slogan
 * lines, stock phrases, punctuation), with the subject checks off, and a
 * voicemail past about 20 seconds. They warn; they never block a call.
 */
export function callBriefFlags(brief: CallBrief): string[] {
  const text = callBriefText(brief);
  const flags = lintEmail("call brief", text, 400, undefined, { threadedSubject: true }).filter(
    // Rules about an email's shape, not about what is said out loud.
    (f) => !/^(too-long|no-question|subject-|signoff|greeting|thin-body)/.test(f),
  );
  const words = brief.voicemail.split(/\s+/).filter(Boolean).length;
  if (words > VOICEMAIL_MAX_WORDS) flags.push(`voicemail-long: ${words} words`);
  return [...new Set(flags)];
}

/**
 * The emails already sent in this play, for the brief's PRIOR EMAILS block:
 * a LinkedIn message or a call is not one, nor is a skipped step.
 */
function priorEmails(prospectId: number, playName: string): PriorStepRow[] {
  const emailSteps = new Set(
    getLedger()
      .listSequenceEventsForProspectPlay(prospectId, playName)
      .filter((e) => e.channel === "email")
      .map((e) => e.step_index),
  );
  return getPriorStepsForProspect(prospectId, playName).filter(
    (s) => s.status !== "skipped" && !!s.body && emailSteps.has(s.stepIndex),
  );
}

/**
 * Write the brief for a call to this prospect: a paid completion on the
 * workspace's configured model. The inputs follow a follow-up email's: the
 * prospect's role and researched facts, the sequence's offer (with the
 * product brief), the emails already sent, the angle, the product line and
 * the voice card, plus earlier calls. Without a play the offer is whatever
 * the product brief supports.
 */
export async function buildCallBrief(input: {
  prospect: ProspectRecord;
  playName: string | null;
  cfg: OneShotConfig;
  /** The sequence's offer as the caller resolved it; read from the cadence otherwise. */
  sequenceOffer?: SequenceOfferValue | null;
}): Promise<CallBrief> {
  const { prospect, playName, cfg } = input;
  const offer =
    input.sequenceOffer !== undefined
      ? input.sequenceOffer
      : playName
        ? sequenceOffer(prospect, playName)
        : null;
  const offerLines = playName
    ? offerBlock(offer, cfg, playName)
    : cfg.productBrief?.trim()
      ? `PRODUCT BRIEF (the only source of product claims):\n${productBriefText(cfg) ?? ""}`
      : null;
  const prior = playName ? priorEmails(prospect.id, playName) : [];
  const priorBlock =
    prior.length > 0
      ? [
          "PRIOR EMAILS (what the founder already sent them; the call follows up on these):",
          ...prior.flatMap((s) => [
            `--- step ${s.stepIndex} (${s.label}) ---`,
            `Subject: ${s.subject}`,
            s.body ?? "",
          ]),
        ].join("\n")
      : null;
  const calls = getLedger().listCallsForProspect(prospect.id).slice(0, 3);
  const callsBlock =
    calls.length > 0
      ? [
          "PRIOR CALLS (newest first):",
          ...calls.map(
            (c) =>
              `- ${c.startedAt.slice(0, 10)}: ${c.outcome ?? "not logged"}${c.note ? ` (${c.note.replace(/\s+/g, " ").slice(0, 200)})` : ""}`,
          ),
        ].join("\n")
      : null;
  const angleBlock = angleBlockFromJson(prospect.angle_json);
  const voice = voiceBlock("call");
  const user = [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(unknown)"}`,
    `PROSPECT: ${prospect.name ?? "(unknown)"}`,
    `COMPANY: ${prospect.company ?? "(unknown)"}`,
    ...prospectContextLines(prospect),
    ...(offerLines ? ["", offerLines] : []),
    ...(priorBlock ? ["", priorBlock] : []),
    ...(callsBlock ? ["", callsBlock] : []),
    ...(angleBlock ? ["", angleBlock] : []),
    ...(voice ? ["", voice.text] : []),
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("call-brief") },
      { role: "user", content: user },
    ],
    temperature: 0.5,
    maxTokens: 900,
  });
  const brief = parseCallBrief(res.content, {
    firstName: firstNameFrom(prospect.name),
    fullName: prospect.name?.trim() || null,
    founderName: cfg.founderName?.trim() || null,
    product: cfg.productOneLiner?.trim() || null,
    offer: offer?.offer ?? null,
    angle: angleHook(prospect.angle_json),
    emailed: prior.length > 0,
  });
  return { ...brief, flags: callBriefFlags(brief) };
}

/** The call step's builder: the brief, the number and their local time now. */
export async function callStepPayload(ctx: CadenceContext, playName: string): Promise<StepPayload> {
  const brief = await buildCallBrief({
    prospect: ctx.prospect,
    playName,
    cfg: ctx.cfg,
    ...(ctx.sequenceOffer !== undefined ? { sequenceOffer: ctx.sequenceOffer } : {}),
  });
  const phone = phoneForCall(ctx.prospect.id, ctx.cfg).phone;
  const local = phone ? phoneLocalTime(phone, callsOf(ctx.cfg).window) : null;
  return {
    kind: "call",
    toPhone: phone ?? "",
    brief,
    ...(local?.localTime ? { localTime: local.localTime } : {}),
  };
}

/**
 * The brief the dial panel shows. For a cadence whose next step is a call,
 * its stored preview (written through the preview path when there is none,
 * or when `regenerate` asks for a new one). For anyone else, the brief cached
 * for them, written on demand once and again only on `regenerate`.
 */
export async function callBriefFor(input: {
  prospectId: number;
  playName?: string | null;
  regenerate?: boolean;
}): Promise<CallBrief> {
  const ledger = getLedger();
  const step =
    input.playName && callStepIsNext(input.prospectId, input.playName) ? input.playName : null;
  if (step) {
    const draft = ledger.getCadenceDraft({ prospectId: input.prospectId, playName: step });
    const stored = draft?.payload as StepPayload | undefined;
    if (!input.regenerate && stored?.kind === "call") return stored.brief;
    const preview = await previewCadenceStep({ prospectId: input.prospectId, playName: step });
    if ("waiting" in preview || "skipped" in preview) throw new Error(preview.message);
    if (preview.payload.kind !== "call") throw new Error("the next step is no longer a call");
    return preview.payload.brief;
  }
  // The play the brief is written for, decided before the cache is read: a
  // brief cached for another play (or for none) is not this one's.
  const playName =
    input.playName ||
    ledger.listCadencesForProspect(input.prospectId).find((c) => c.status === "active")
      ?.play_name ||
    ledger.latestSentPlayForProspect(input.prospectId) ||
    null;
  const prospect = ledger.getProspectById(input.prospectId);
  if (!prospect) throw new Error("prospect not found");
  // The offer it restates, read as the brief reads it: an offer changed on
  // the cadence or its queue row since makes the cached brief stale.
  const offer = playName ? sequenceOffer(prospect, playName) : null;
  const offerKey = offerKeyOf(offer);
  if (!input.regenerate) {
    const cached = ledger.getCallBrief(input.prospectId);
    if (cached && cached.playName === playName && cached.offerKey === offerKey) return cached.brief;
  }
  const brief = await buildCallBrief({
    prospect,
    playName,
    cfg: loadConfig(),
    sequenceOffer: offer,
  });
  ledger.saveCallBrief({ prospectId: input.prospectId, playName, brief, offerKey });
  return brief;
}

/** The cadence whose next step is a call this outcome is logged against, if any. */
function callStepPlay(prospectId: number, playName: string | null | undefined): string | null {
  if (playName) return callStepIsNext(prospectId, playName) ? playName : null;
  return (
    getLedger()
      .listCadencesForProspect(prospectId)
      .find((c) => c.status === "active" && callStepIsNext(prospectId, c.play_name))?.play_name ??
    null
  );
}

/** A sequence event's `created_at` (SQLite's "YYYY-MM-DD HH:MM:SS", UTC, or ISO) in ms. */
function eventMs(createdAt: string): number {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)
      ? `${createdAt.replace(" ", "T")}Z`
      : createdAt,
  );
}

/**
 * Whether a call already written may complete the cadence's current call
 * step: it completed no step yet (a replayed log must not complete the next
 * one), and it was made while that step was current, not for an earlier
 * one. A cadence row is re-activated in place, so a step, not the
 * enrolment, is what a call belongs to.
 */
function callOwnsCurrentStep(
  call: Pick<CallRecordView, "id" | "prospectId" | "startedAt">,
  playName: string,
): boolean {
  const ledger = getLedger();
  const cadence = ledger.getCadence(call.prospectId, playName);
  if (!cadence) return false;
  const events = ledger.listSequenceEventsForProspectPlay(call.prospectId, playName);
  const completed = events.some(
    (e) =>
      e.channel === "call" &&
      tryParseJsonObject<{ callId?: unknown }>(e.metadata_json ?? "", {}).callId === call.id,
  );
  if (completed) return false;
  // The current step began with the last event before it (or the enrolment).
  const began = Math.max(
    eventMs(cadence.enrolled_at),
    ...events.filter((e) => e.step_index <= cadence.current_step).map((e) => eventMs(e.created_at)),
  );
  return !(Date.parse(call.startedAt) < began);
}

/** `holdUntil` ("YYYY-MM-DD", or an ISO time) as the instant the hold ends; the default when absent or past. */
function holdUntilIso(raw: string | undefined, now: Date): string {
  const parsed = raw
    ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw)
    : Number.NaN;
  return Number.isFinite(parsed) && parsed > now.getTime()
    ? new Date(parsed).toISOString()
    : new Date(now.getTime() + NOT_NOW_DEFAULT_DAYS * 24 * 3600 * 1000).toISOString();
}

/** Thrown for a request `recordCall` refuses; the route answers with its status and message. */
export class CallLogError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "CallLogError";
  }
}

/**
 * Log a call's outcome. Every outcome writes the `calls` row and a
 * `channel_events` touch (channel `call`). When the prospect's cadence has
 * the call step next, the step is recorded (a `call` sequence event carrying
 * the outcome). Then, per outcome:
 *
 *   - no_answer, voicemail, gatekeeper, wrong_person: the step is done and
 *     the cadence moves on, as after a sent step;
 *   - wrong_number: the same, and the prospect's number is cleared (the call
 *     row keeps it, and that number is never offered again);
 *   - interested: as a reply: live cadences stop as replied, and the call
 *     step (else the latest email) is marked replied;
 *   - meeting_booked: as interested, plus a `meeting_booked` outcome;
 *   - not_interested: as a reply;
 *   - not_now: the step is done and every live cadence is held until
 *     `holdUntil` (default two weeks);
 *   - do_not_contact: every cadence stops as unsubscribed, and the call's
 *     outcome blocks every channel (`contactAllowedClause`). It is final: a
 *     later log on the same call that changes it is refused (409).
 *
 * A log on an existing call (`callId`) completes only the call step of the
 * cadence that call was made in, when it recorded one. A new call records
 * `req.phone`, the number the founder dialled, when it parses, so a
 * wrong_number lands on that number even if the stored one changed since.
 */
export function recordCall(
  prospectId: number,
  req: LogCallRequest,
  now: Date = new Date(),
): CallRecordView {
  const ledger = getLedger();
  const outcome: CallOutcome = req.outcome;
  const meta = CALL_OUTCOMES.find((o) => o.outcome === outcome);
  if (!meta) throw new CallLogError("unknown outcome", 400);
  if (!ledger.getProspectById(prospectId)) throw new CallLogError("prospect not found", 404);
  const cfg = loadConfig();
  const note = req.note?.trim() || null;
  const durationSec =
    typeof req.durationSec === "number" && Number.isFinite(req.durationSec) && req.durationSec >= 0
      ? Math.round(req.durationSec)
      : null;
  // One transaction: the call row, its touch and what the outcome does to
  // the cadences land together, or none of them does.
  const { callId, stepPlay } = ledger.inTransaction(() =>
    applyCallOutcome(prospectId, req, { outcome, note, durationSec, cfg, now }),
  );
  logEvent("call.logged", { prospect_id: prospectId, outcome, cadence_step: stepPlay != null });
  return ledger.getCall(callId)!;
}

/** `recordCall`'s writes, run inside its transaction. */
function applyCallOutcome(
  prospectId: number,
  req: LogCallRequest,
  ctx: {
    outcome: CallOutcome;
    note: string | null;
    durationSec: number | null;
    cfg: OneShotConfig;
    now: Date;
  },
): { callId: number; stepPlay: string | null } {
  const ledger = getLedger();
  const { outcome, note, durationSec, cfg, now } = ctx;
  const existing = req.callId != null ? ledger.getCall(req.callId) : null;
  if (req.callId != null && existing?.prospectId !== prospectId)
    throw new CallLogError("call not found", 404);
  if (existing?.outcome === "do_not_contact" && outcome !== "do_not_contact")
    throw new CallLogError("this call was logged do not contact; that stays", 409);
  // An existing call's own cadence, when it recorded one: never another
  // cadence whose next step happens to be a call, and only the step it was
  // made for.
  const nextCall = callStepPlay(prospectId, existing?.playName ?? req.playName);
  const stepPlay =
    nextCall && existing && !callOwnsCurrentStep(existing, nextCall) ? null : nextCall;
  const playName = stepPlay ?? existing?.playName ?? req.playName ?? null;
  const country = defaultPhoneCountry(cfg);
  let callId: number;
  let dialled: string | null;
  if (req.callId != null) {
    if (
      !ledger.setCallOutcome({ id: req.callId, prospectId, outcome, note, durationSec, playName })
    )
      throw new CallLogError("call not found", 404);
    callId = req.callId;
    dialled = ledger.callPhone(callId);
  } else {
    const number = phoneForCall(prospectId, cfg);
    dialled = normalizePhone(req.phone, country) ?? number.phone ?? number.raw;
    callId = ledger.insertCall({
      prospectId,
      playName,
      startedAt: new Date(now.getTime() - (durationSec ?? 0) * 1000).toISOString(),
      durationSec,
      outcome,
      note,
      phone: dialled,
      provider: "tel",
    });
  }
  const nowIso = now.toISOString();
  ledger.recordCallChannelEvent({ callId, prospectId, outcome, occurredAt: nowIso });
  const stepMeta = { outcome, callId, ...(note ? { note } : {}) };
  const replied = CALL_REPLY_OUTCOMES.has(outcome);
  if (stepPlay) {
    completeCallStep({
      prospectId,
      playName: stepPlay,
      metadata: stepMeta,
      ...(replied ? { status: "replied" as const } : {}),
    });
  }
  // Only the number that rang the wrong person: a replacement stays.
  if (outcome === "wrong_number") ledger.clearProspectPhone(prospectId, dialled, country);
  if (outcome === "not_now") {
    const until = holdUntilIso(req.holdUntil, now);
    for (const c of ledger.listCadencesForProspect(prospectId)) {
      if (c.status !== "active") continue;
      ledger.holdCadence({ prospectId, playName: c.play_name, until, reason: "not-now" });
    }
  }
  if (outcome === "interested" || outcome === "meeting_booked" || outcome === "not_interested") {
    // Credited like an email reply: to the call step when it was one, else
    // to the latest email the person was sent.
    const credited = stepPlay ?? ledger.latestSentPlayForProspect(prospectId);
    if (credited) {
      ledger.markLatestStepReplied({
        prospectId,
        playName: credited,
        repliedAt: nowIso,
        channel: stepPlay ? "call" : "email",
      });
    }
    ledger.suppressCadencesForReply(prospectId);
  }
  // A repeated log of the same booking records the meeting once.
  if (outcome === "meeting_booked" && existing?.outcome !== "meeting_booked") {
    ledger.recordOutcome({
      prospectId,
      ...(playName ? { playName } : {}),
      outcome: "meeting_booked",
      ...(note ? { notes: note } : {}),
    });
  }
  if (outcome === "do_not_contact") stopCadencesForOptOut(prospectId);
  return { callId, stepPlay };
}

/** Why a call-list row ranks where it does. */
function tierReason(c: CallCandidate): string {
  switch (c.tier) {
    case 1:
      return `replied: ${c.replyIntent ?? "interested"}`;
    case 2:
      return "LinkedIn connected";
    case 3:
      return c.playName ? `in cadence: ${c.playName}` : "in a cadence";
    default:
      return "has a number";
  }
}

/**
 * The Calls page: due call steps first, then everyone else with a usable
 * number, ranked (`listCallCandidates`), at most `CALL_LIST_LIMIT`. Every row
 * passes the send gates: the company do-not-contact list, an opt-out on any
 * channel (a call logged do-not-contact included), an ICP reject, a meeting
 * already held. A due step is listed without a number (the page offers Find
 * phone); the call list only lists people with one. Calls off: nothing is
 * read beyond the config.
 */
export function listCalls(
  now: Date = new Date(),
  /** Tests: a smaller list and page. */
  opts: { limit?: number; pageSize?: number } = {},
): CallListResponse {
  const limit = opts.limit ?? CALL_LIST_LIMIT;
  const pageSize = opts.pageSize ?? CALL_CANDIDATE_PAGE;
  const cfg = loadConfig();
  const calls = callsOf(cfg);
  const base = {
    enabled: calls.enabled,
    dialMode: calls.bridge ? ("bridge" as const) : ("tel" as const),
    window: calls.window,
  };
  if (!calls.enabled) return { ...base, due: [], list: [] };
  const ledger = getLedger();
  const dnc = doNotContactOf(cfg);
  const dncOn = dnc.domains.length > 0 || dnc.companies.length > 0;
  const blocked = (prospectId: number, email: string | null) =>
    dncOn && doNotContactMatch(ledger.contactIdentityFor({ prospectId, email }), dnc) != null;
  const local = (phone: string | null) => phoneLocalTime(phone, calls.window, now);

  const due: CallListRow[] = [];
  const dueIds = new Set<number>();
  const dueCalls = ledger.listActiveCadences({ dueByIso: now.toISOString() }).flatMap((cad) => {
    const next = nextStepInfo(cad.play_name, cad.current_step, cad.prospect_id);
    return next?.channel === "call" ? [{ cad, next }] : [];
  });
  // One opt-out read for every due row, not one per row.
  const allowed = ledger.callAllowedIds([...new Set(dueCalls.map((d) => d.cad.prospect_id))]);
  for (const { cad, next } of dueCalls) {
    if (dueIds.has(cad.prospect_id)) continue;
    if (!allowed.has(cad.prospect_id) || blocked(cad.prospect_id, cad.prospect_email)) continue;
    const phone = phoneForCall(cad.prospect_id, cfg);
    dueIds.add(cad.prospect_id);
    due.push({
      prospectId: cad.prospect_id,
      name: cad.prospect_name,
      title: cad.prospect_title,
      company: cad.prospect_company,
      phone: phone.phone,
      queueId: phone.queueId,
      local: local(phone.phone),
      playName: cad.play_name,
      section: "due",
      reason: `due: ${next.label ?? "call"} · ${cad.play_name}`,
      lastTouchAt: null,
      lastCall: null,
    });
  }

  const list: CallListRow[] = [];
  const country = defaultPhoneCountry(cfg);
  const listRow = (
    c: CallCandidate,
    wrong: ReadonlySet<string> | undefined,
  ): CallListRow | null => {
    if (blocked(c.prospectId, c.email)) return null;
    const phone = pickCallPhone(
      { prospectPhone: c.prospectPhone, queuePhone: c.queuePhone, queueId: c.queueId },
      wrong,
      country,
    );
    if (!phone.phone) return null;
    return {
      prospectId: c.prospectId,
      name: c.name,
      title: c.title,
      company: c.company,
      phone: phone.phone,
      queueId: phone.queueId ?? c.queueId,
      local: local(phone.phone),
      playName: null,
      section: "list",
      reason: tierReason(c),
      lastTouchAt: c.lastTouchAt,
      lastCall: null,
    };
  };
  // The limit counts rows that pass the company list and have a usable
  // number: page through the ranked candidates, in order, until it is met
  // or they run out (bounded; the first page is normally enough).
  for (let page = 0; page < CALL_CANDIDATE_PAGES && list.length < limit; page++) {
    const candidates = ledger.listCallCandidates({
      limit: pageSize,
      offset: page * pageSize,
      excludeProspectIds: [...dueIds],
    });
    const wrong = ledger.wrongNumbersFor(
      candidates.map((c) => c.prospectId),
      country,
    );
    for (const c of candidates) {
      if (list.length >= limit) break;
      const row = listRow(c, wrong.get(c.prospectId));
      if (row) list.push(row);
    }
    if (candidates.length < pageSize) break;
  }

  const ids = [...due, ...list].map((r) => r.prospectId);
  const lastCalls = ledger.lastCallsFor(ids);
  const touches = ledger.lastTouchFor(due.map((r) => r.prospectId));
  for (const row of [...due, ...list]) {
    row.lastCall = lastCalls.get(row.prospectId) ?? null;
    if (row.section === "due") row.lastTouchAt = touches.get(row.prospectId) ?? null;
  }
  return { ...base, due, list };
}
