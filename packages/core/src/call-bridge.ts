/**
 * Bridged calls over Twilio's REST API with raw `fetch` (docs/calls.md). The
 * server is localhost-only, so every step is a request it makes and polls:
 * TwiML goes inline and no webhook URL is ever sent. Auth is an API key on
 * the (sub)account, never the account's auth token.
 */
import type { CallRecordView } from "@oneshot-gtm/shared-types";
import type { BridgeCallStatus } from "./ledger-calls.ts";
import { getSharedDb } from "./shared-db.ts";

const API = "https://api.twilio.com/2010-04-01";
const INTELLIGENCE = "https://intelligence.twilio.com/v2";

/** The install's transcription service, found or created by this name. */
export const TRANSCRIPTION_SERVICE_NAME = "oneshot-gtm-dialler";
/** `install_settings` key the service's SID is kept under. */
const SERVICE_SETTING = "calls.transcriptionServiceSid";

/** Most sentence pages read for one transcript (1,000 sentences a page). */
const MAX_SENTENCE_PAGES = 10;
/** One deadline per request, the body read included. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long the member's answered leg waits for a poll to dial the prospect before it hangs up. */
export const HOLD_SECONDS = 40;

export interface TwilioKeys {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
}

/** The provider keys from the environment (the workspace's `.env`); null unless all three are set. */
export function twilioKeysFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioKeys | null {
  const accountSid = env["TWILIO_ACCOUNT_SID"]?.trim();
  const apiKeySid = env["TWILIO_API_KEY_SID"]?.trim();
  const apiKeySecret = env["TWILIO_API_KEY_SECRET"]?.trim();
  return accountSid && apiKeySid && apiKeySecret ? { accountSid, apiKeySid, apiKeySecret } : null;
}

/** A provider call that failed, with the provider's own message. */
export class CallBridgeError extends Error {
  constructor(
    message: string,
    /** The HTTP status the provider answered with; 0 when it could not be reached. */
    readonly status: number,
    /** The provider's error code, when it gave one (Twilio's 5-digit codes). */
    readonly code: number | null = null,
    /** A write that timed out: the provider may or may not have done it. */
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "CallBridgeError";
  }
}

/** Twilio's "this number is already a verified caller ID" refusal. */
export const ALREADY_VERIFIED_CODE = 21450;

export interface BridgeCallState {
  status: BridgeCallStatus;
  /** Seconds the member and the prospect talked (live while connected); null before that. */
  durationSec: number | null;
  /** True once the prospect's leg answered. */
  answered: boolean;
  /** Who picked up the member's leg (`human`, `machine_start`, `fax`, `unknown`); null while detecting. */
  answeredBy: string | null;
}

/** Answering-machine detection says the member's own phone did not pick up: a voicemail or a fax. */
export function answeredByMachine(answeredBy: string | null): boolean {
  return answeredBy != null && (answeredBy.startsWith("machine") || answeredBy === "fax");
}

export interface BridgeRecording {
  sid: string;
  /** The provider's state: processing, completed, absent, … */
  status: string;
  durationSec: number | null;
}

export type TranscriptLine = NonNullable<CallRecordView["transcript"]>[number];

export interface BridgeTranscript {
  status: "pending" | "ready" | "failed";
  /** When ready: the sentences in order, the member's channel as `founder`. */
  lines?: TranscriptLine[];
}

/** What the routes and the sweep need from a call provider. */
export interface CallBridge {
  /** The provider account the keys act on. */
  readonly accountSid: string;
  verifyCallerId(phone: string): Promise<{ validationCode: string }>;
  isVerified(phone: string): Promise<boolean>;
  /** Remove `phone` as a caller ID, so using it again needs a fresh code. */
  removeCallerId(phone: string): Promise<void>;
  /** Ring the member, detect who answers and hold (`holdTwiml`); nobody else is dialled yet. */
  start(input: { memberPhone: string; sayName: string | null }): Promise<{ callSid: string }>;
  /** Dial the prospect on a held call (`dialTwiml`). */
  connect(
    callSid: string,
    input: { memberPhone: string; prospectPhone: string; record: boolean },
  ): Promise<void>;
  /** Start recording a connected call: the member on channel 1, the prospect on 2. */
  startRecording(callSid: string): Promise<void>;
  /**
   * Stop (pause) or resume the call's recording, whichever way it started.
   * A stopped stretch is left out of the recording, so the transcript has
   * only what was said while it recorded.
   */
  setRecordingPaused(callSid: string, paused: boolean): Promise<void>;
  status(callSid: string): Promise<BridgeCallState>;
  hangUp(callSid: string): Promise<void>;
  recording(callSid: string): Promise<BridgeRecording | null>;
  deleteRecording(recordingSid: string): Promise<void>;
  /** The install's transcription service SID, created when the account has none. */
  ensureService(): Promise<string>;
  /** Start transcribing a recording, or find the transcript an earlier request made. */
  transcribe(input: {
    recordingSid: string;
    serviceSid: string;
  }): Promise<{ transcriptSid: string }>;
  transcript(transcriptSid: string): Promise<BridgeTranscript>;
  /** Every transcript made from a recording. */
  transcriptsFor(recordingSid: string): Promise<string[]>;
  deleteTranscript(transcriptSid: string): Promise<void>;
}

/** XML text and attribute escaping, for every value put into TwiML. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The member's leg while it is judged: the provider runs answering-machine
 * detection before this starts, then the member hears who is being called
 * and holds until a poll dials the prospect (`dialTwiml`). Nobody polling
 * means the hold runs out and the call ends with no one dialled.
 */
export function holdTwiml(sayName: string | null): string {
  const say = sayName?.replace(/\s+/g, " ").trim();
  return `<Response>${say ? `<Say>Calling ${xmlEscape(say)}</Say>` : ""}<Pause length="${HOLD_SECONDS}"/></Response>`;
}

/** Dial the prospect with the member's number as the caller ID, recorded on two channels when `record`. */
export function dialTwiml(input: {
  memberPhone: string;
  prospectPhone: string;
  record: boolean;
}): string {
  return [
    `<Response><Dial callerId="${xmlEscape(input.memberPhone)}" answerOnBridge="true"`,
    input.record ? ` record="record-from-answer-dual"` : "",
    `><Number>${xmlEscape(input.prospectPhone)}</Number></Dial></Response>`,
  ].join("");
}

interface TwilioCall {
  sid: string;
  status: string;
  duration?: string | number | null;
  start_time?: string | null;
  answered_by?: string | null;
}

const RINGING = new Set(["queued", "initiated", "ringing"]);

/** Whole seconds from a provider's duration field; null when empty. */
function seconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return value !== "" && value != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * The parent call is the member's leg, the child the prospect's. A member's
 * leg that never went through (busy, no answer, failed) is `failed`; a
 * hang-up while ringing (canceled) is `ended`. The duration is talk time.
 */
export function mapBridgeStatus(
  parent: TwilioCall,
  child: TwilioCall | null,
  now: Date = new Date(),
): BridgeCallState {
  const answered =
    child != null && (child.status === "in-progress" || child.status === "completed");
  const answeredBy = parent.answered_by || null;
  const childDuration = (): number | null => {
    if (!child) return null;
    if (child.status === "in-progress") {
      const started = child.start_time ? Date.parse(child.start_time) : NaN;
      return Number.isFinite(started)
        ? Math.max(0, Math.round((now.getTime() - started) / 1000))
        : null;
    }
    return seconds(child.duration);
  };
  if (RINGING.has(parent.status))
    return { status: "ringing_founder", durationSec: null, answered, answeredBy };
  if (parent.status === "in-progress") {
    if (!child || RINGING.has(child.status))
      return { status: "ringing_prospect", durationSec: null, answered, answeredBy };
    if (child.status === "in-progress")
      return { status: "connected", durationSec: childDuration(), answered, answeredBy };
    return { status: "ended", durationSec: childDuration(), answered, answeredBy };
  }
  if (parent.status === "completed" || parent.status === "canceled")
    return { status: "ended", durationSec: childDuration(), answered, answeredBy };
  return { status: "failed", durationSec: childDuration(), answered, answeredBy };
}

/**
 * Sentences in order, labelled by channel: 1 is the member (`founder`), 2 the
 * prospect. Empty text is dropped.
 */
export function transcriptLines(
  sentences: ReadonlyArray<{
    media_channel?: unknown;
    sentence_index?: unknown;
    start_time?: unknown;
    transcript?: unknown;
  }>,
): TranscriptLine[] {
  return sentences
    .toSorted((a, b) => Number(a.sentence_index ?? 0) - Number(b.sentence_index ?? 0))
    .flatMap((s) => {
      const text = typeof s.transcript === "string" ? s.transcript.replace(/\s+/g, " ").trim() : "";
      if (!text) return [];
      const start = Number(s.start_time);
      return [
        {
          speaker: Number(s.media_channel) === 2 ? ("prospect" as const) : ("founder" as const),
          text,
          startSec: Number.isFinite(start) ? Math.round(start * 10) / 10 : 0,
        },
      ];
    });
}

/** Errors that say the connection never opened, so no request reached the provider. */
const NEVER_CONNECTED = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "FailedToOpenSocket",
  "UnableToConnect",
]);

function neverConnected(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && NEVER_CONNECTED.has(code);
}

/** Twilio over REST, with `fetch` injectable for tests. */
export class TwilioBridge implements CallBridge {
  private readonly fetchImpl: () => typeof fetch;
  private readonly timeoutMs: number;
  readonly accountSid: string;

  constructor(
    private readonly keys: TwilioKeys,
    opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    // Read at call time, so a test's stubbed global fetch is the one used.
    this.fetchImpl = () => opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.accountSid = keys.accountSid;
  }

  private account(path: string): string {
    return `${API}/Accounts/${encodeURIComponent(this.keys.accountSid)}/${path}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    form?: Record<string, string>,
    opts: { allow404?: boolean } = {},
  ): Promise<T | null> {
    const auth = Buffer.from(`${this.keys.apiKeySid}:${this.keys.apiKeySecret}`).toString("base64");
    let res: Response | undefined;
    let text: string;
    try {
      res = await this.fetchImpl()(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Basic ${auth}`,
          accept: "application/json",
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
      text = await res.text();
    } catch (err) {
      // A write that may have reached Twilio (a timeout, a reset before or
      // after the headers, an accepted answer lost) is unknown, not refused.
      const refusedBefore = res ? !res.ok : neverConnected(err);
      if (method !== "GET" && !refusedBefore)
        throw new CallBridgeError(
          "Twilio did not answer in time, so it may or may not have done it",
          0,
          null,
          true,
        );
      throw new CallBridgeError(
        `Twilio could not be reached: ${(err as Error).message ?? "network error"}`,
        0,
      );
    }
    if (res.status === 404 && opts.allow404) return null;
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const b = (body ?? {}) as { message?: unknown; code?: unknown };
      const message = typeof b.message === "string" && b.message ? b.message : `HTTP ${res.status}`;
      throw new CallBridgeError(
        `Twilio: ${message}`,
        res.status,
        typeof b.code === "number" ? b.code : null,
      );
    }
    return body as T;
  }

  async verifyCallerId(phone: string): Promise<{ validationCode: string }> {
    const body = await this.request<{ validation_code?: unknown }>(
      "POST",
      this.account("OutgoingCallerIds.json"),
      { PhoneNumber: phone, FriendlyName: phone },
    );
    const code = body?.validation_code;
    if (typeof code !== "string" && typeof code !== "number")
      throw new CallBridgeError("Twilio did not return a validation code", 502);
    return { validationCode: String(code) };
  }

  private async callerIds(phone: string): Promise<string[]> {
    const body = await this.request<{
      outgoing_caller_ids?: Array<{ sid?: unknown; phone_number?: unknown }>;
    }>("GET", this.account(`OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(phone)}`));
    return (body?.outgoing_caller_ids ?? [])
      .filter((c) => c.phone_number === phone && typeof c.sid === "string")
      .map((c) => c.sid as string);
  }

  async isVerified(phone: string): Promise<boolean> {
    return (await this.callerIds(phone)).length > 0;
  }

  async removeCallerId(phone: string): Promise<void> {
    for (const sid of await this.callerIds(phone))
      await this.request(
        "DELETE",
        this.account(`OutgoingCallerIds/${encodeURIComponent(sid)}.json`),
        undefined,
        { allow404: true },
      );
  }

  /** `MachineDetection=Enable` is synchronous: the hold starts only once the provider knows who answered. */
  async start(input: {
    memberPhone: string;
    sayName: string | null;
  }): Promise<{ callSid: string }> {
    const body = await this.request<{ sid?: unknown }>("POST", this.account("Calls.json"), {
      To: input.memberPhone,
      From: input.memberPhone,
      MachineDetection: "Enable",
      Twiml: holdTwiml(input.sayName),
    });
    // Accepted without a SID: the phone may ring all the same.
    if (typeof body?.sid !== "string")
      throw new CallBridgeError("Twilio did not return a call", 502, null, true);
    return { callSid: body.sid };
  }

  async connect(
    callSid: string,
    input: { memberPhone: string; prospectPhone: string; record: boolean },
  ): Promise<void> {
    await this.request("POST", this.account(`Calls/${encodeURIComponent(callSid)}.json`), {
      Twiml: dialTwiml(input),
    });
  }

  /**
   * Recording the parent leg in two channels keeps each side apart: Twilio
   * puts the parent call (the member) on the first and the child (the
   * prospect) on the second.
   */
  async startRecording(callSid: string): Promise<void> {
    await this.request(
      "POST",
      this.account(`Calls/${encodeURIComponent(callSid)}/Recordings.json`),
      { RecordingChannels: "dual" },
    );
  }

  async setRecordingPaused(callSid: string, paused: boolean): Promise<void> {
    await this.request(
      "POST",
      this.account(`Calls/${encodeURIComponent(callSid)}/Recordings/Twilio.CURRENT.json`),
      paused ? { Status: "paused", PauseBehavior: "skip" } : { Status: "in-progress" },
    );
  }

  private async call(callSid: string): Promise<TwilioCall> {
    const call = await this.request<TwilioCall>(
      "GET",
      this.account(`Calls/${encodeURIComponent(callSid)}.json`),
    );
    if (!call) throw new CallBridgeError("Twilio did not return the call", 502);
    return call;
  }

  async status(callSid: string): Promise<BridgeCallState> {
    const parent = await this.call(callSid);
    const children = await this.request<{ calls?: TwilioCall[] }>(
      "GET",
      this.account(`Calls.json?ParentCallSid=${encodeURIComponent(callSid)}`),
    );
    // One <Dial><Number> makes one child; the newest wins if there are more.
    const child = children?.calls?.[0] ?? null;
    return mapBridgeStatus(parent, child);
  }

  /**
   * `canceled` ends a call still ringing, `completed` one in progress; one
   * already over is left alone. A call answered between the read and the
   * cancel refuses it: read again and end it as it is now.
   */
  async hangUp(callSid: string): Promise<void> {
    const end = (status: string) =>
      RINGING.has(status) ? "canceled" : status === "in-progress" ? "completed" : null;
    const first = end((await this.call(callSid)).status);
    if (!first) return;
    const post = (Status: string) =>
      this.request("POST", this.account(`Calls/${encodeURIComponent(callSid)}.json`), { Status });
    try {
      await post(first);
    } catch (err) {
      if (err instanceof CallBridgeError && err.uncertain) throw err;
      const now = end((await this.call(callSid)).status);
      if (!now) return;
      if (now === first) throw err;
      await post(now);
    }
  }

  async recording(callSid: string): Promise<BridgeRecording | null> {
    const body = await this.request<{
      recordings?: Array<{ sid?: unknown; status?: unknown; duration?: unknown }>;
    }>("GET", this.account(`Recordings.json?CallSid=${encodeURIComponent(callSid)}`));
    const r = body?.recordings?.find((x) => typeof x.sid === "string");
    if (!r) return null;
    return {
      sid: r.sid as string,
      status: typeof r.status === "string" ? r.status : "processing",
      durationSec: seconds(r.duration),
    };
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    await this.request(
      "DELETE",
      this.account(`Recordings/${encodeURIComponent(recordingSid)}.json`),
      undefined,
      { allow404: true },
    );
  }

  async ensureService(): Promise<string> {
    const lookup = () =>
      this.request<{ sid?: unknown }>(
        "GET",
        `${INTELLIGENCE}/Services/${TRANSCRIPTION_SERVICE_NAME}`,
        undefined,
        { allow404: true },
      );
    const found = await lookup();
    if (typeof found?.sid === "string") return found.sid;
    try {
      const created = await this.request<{ sid?: unknown }>("POST", `${INTELLIGENCE}/Services`, {
        UniqueName: TRANSCRIPTION_SERVICE_NAME,
        FriendlyName: "Dialler call transcripts",
        AutoTranscribe: "false",
      });
      if (typeof created?.sid === "string") return created.sid;
    } catch (err) {
      // Another workspace created it a moment ago: the name is taken now.
      const again = await lookup();
      if (typeof again?.sid === "string") return again.sid;
      throw err;
    }
    throw new CallBridgeError("Twilio did not return a transcription service", 502);
  }

  async transcriptsFor(recordingSid: string): Promise<string[]> {
    const body = await this.request<{ transcripts?: Array<{ sid?: unknown }> }>(
      "GET",
      `${INTELLIGENCE}/Transcripts?SourceSid=${encodeURIComponent(recordingSid)}`,
    );
    return (body?.transcripts ?? [])
      .map((t) => t.sid)
      .filter((sid): sid is string => typeof sid === "string");
  }

  /** Looked up first and again after a failed create: one transcript per recording, even after a timeout. */
  async transcribe(input: {
    recordingSid: string;
    serviceSid: string;
  }): Promise<{ transcriptSid: string }> {
    const existing = (await this.transcriptsFor(input.recordingSid))[0];
    if (existing) return { transcriptSid: existing };
    const channel = {
      media_properties: { source_sid: input.recordingSid },
      participants: [
        { channel_participant: 1, role: "Agent" },
        { channel_participant: 2, role: "Customer" },
      ],
    };
    let body: { sid?: unknown } | null;
    try {
      body = await this.request<{ sid?: unknown }>("POST", `${INTELLIGENCE}/Transcripts`, {
        ServiceSid: input.serviceSid,
        Channel: JSON.stringify(channel),
      });
    } catch (err) {
      const made = (await this.transcriptsFor(input.recordingSid))[0];
      if (made) return { transcriptSid: made };
      throw err;
    }
    if (typeof body?.sid !== "string")
      throw new CallBridgeError("Twilio did not return a transcript", 502);
    return { transcriptSid: body.sid };
  }

  async deleteTranscript(transcriptSid: string): Promise<void> {
    await this.request(
      "DELETE",
      `${INTELLIGENCE}/Transcripts/${encodeURIComponent(transcriptSid)}`,
      undefined,
      { allow404: true },
    );
  }

  async transcript(transcriptSid: string): Promise<BridgeTranscript> {
    const t = await this.request<{ status?: unknown }>(
      "GET",
      `${INTELLIGENCE}/Transcripts/${encodeURIComponent(transcriptSid)}`,
    );
    const status = typeof t?.status === "string" ? t.status : "";
    if (status === "failed" || status === "canceled" || status === "error")
      return { status: "failed" };
    if (status !== "completed") return { status: "pending" };
    const sentences: Array<Record<string, unknown>> = [];
    let url: string | null =
      `${INTELLIGENCE}/Transcripts/${encodeURIComponent(transcriptSid)}/Sentences?PageSize=1000`;
    for (let page = 0; url && page < MAX_SENTENCE_PAGES; page++) {
      const body: {
        sentences?: Array<Record<string, unknown>>;
        meta?: { next_page_url?: unknown };
      } | null = await this.request("GET", url);
      sentences.push(...(body?.sentences ?? []));
      const next: unknown = body?.meta?.next_page_url;
      url = typeof next === "string" && next.startsWith(INTELLIGENCE) ? next : null;
    }
    return { status: "ready", lines: transcriptLines(sentences) };
  }
}

/** The bridge for this workspace's keys, or null when they are not all set. */
export function callBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): CallBridge | null {
  const keys = twilioKeysFromEnv(env);
  return keys ? new TwilioBridge(keys, opts) : null;
}

/**
 * The configured service, else the install's kept one, else one found or
 * created on the account. The kept SID names its account: keys for another
 * account get that account's service, which then replaces it.
 */
export async function resolveTranscriptionService(
  bridge: CallBridge,
  configured: string | null,
): Promise<string> {
  if (configured) return configured;
  const shared = getSharedDb();
  let kept: { accountSid?: unknown; sid?: unknown } | null = null;
  try {
    kept = JSON.parse(shared.installSetting(SERVICE_SETTING) ?? "null");
  } catch {
    kept = null;
  }
  if (kept?.accountSid === bridge.accountSid && typeof kept.sid === "string") return kept.sid;
  const sid = await bridge.ensureService();
  shared.setInstallSetting(SERVICE_SETTING, JSON.stringify({ accountSid: bridge.accountSid, sid }));
  return sid;
}

/** Drop the install's kept service when it is `sid`, so the next resolve finds or creates one. */
export function forgetTranscriptionService(sid: string): void {
  const shared = getSharedDb();
  if (shared.installSetting(SERVICE_SETTING)?.includes(JSON.stringify(sid)))
    shared.setInstallSetting(SERVICE_SETTING, "null");
}

/** A transcript create refused because its service no longer exists. */
export function isMissingServiceError(err: unknown): boolean {
  if (!(err instanceof CallBridgeError)) return false;
  if (err.status === 404 || err.code === 20404) return true;
  // Plain substring checks: a pattern with `.*` here is slow on provider-supplied text.
  const text = err.message.toLowerCase();
  const at = text.indexOf("service");
  if (at < 0) return false;
  return ["not found", "not be found", "does not exist", "doesn't exist", "doesnt exist"].some(
    (phrase) => text.indexOf(phrase, at) >= 0,
  );
}
