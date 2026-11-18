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
  /** Ask the provider to verify `phone` as a caller ID: it rings the phone and the member types `validationCode`. */
  verifyCallerId(phone: string): Promise<{ validationCode: string }>;
  /** True once `phone` is a verified caller ID on the account. */
  isVerified(phone: string): Promise<boolean>;
  /** Ring `memberPhone`, then dial `prospectPhone` from it. Returns the call's SID. */
  start(input: {
    memberPhone: string;
    prospectPhone: string;
    /** Said to the member when they pick up ("Calling {sayName}"); null for none. */
    sayName: string | null;
    record: boolean;
  }): Promise<{ callSid: string }>;
  status(callSid: string): Promise<BridgeCallState>;
  hangUp(callSid: string): Promise<void>;
  /** The call's recording, or null while there is none. */
  recording(callSid: string): Promise<BridgeRecording | null>;
  /** The install's transcription service SID, created when the account has none. */
  ensureService(): Promise<string>;
  /** Start transcribing a recording. Returns the transcript's SID. */
  transcribe(input: {
    recordingSid: string;
    serviceSid: string;
  }): Promise<{ transcriptSid: string }>;
  transcript(transcriptSid: string): Promise<BridgeTranscript>;
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
 * The call's instructions, sent inline (`Twiml`), so the provider never
 * fetches anything from this server: say who is being called, then dial
 * them with the member's number as the caller ID. `answerOnBridge` keeps the
 * member hearing ringing until the prospect answers. Recorded from the
 * answer on two channels when `record`.
 */
export function bridgeTwiml(input: {
  memberPhone: string;
  prospectPhone: string;
  sayName: string | null;
  record: boolean;
}): string {
  const say = input.sayName?.replace(/\s+/g, " ").trim();
  return [
    "<Response>",
    say ? `<Say>Calling ${xmlEscape(say)}</Say>` : "",
    `<Dial callerId="${xmlEscape(input.memberPhone)}" answerOnBridge="true"`,
    input.record ? ` record="record-from-answer-dual"` : "",
    `><Number>${xmlEscape(input.prospectPhone)}</Number></Dial>`,
    "</Response>",
  ].join("");
}

interface TwilioCall {
  sid: string;
  status: string;
  duration?: string | number | null;
  start_time?: string | null;
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
  if (RINGING.has(parent.status)) return { status: "ringing_founder", durationSec: null, answered };
  if (parent.status === "in-progress") {
    if (!child || RINGING.has(child.status))
      return { status: "ringing_prospect", durationSec: null, answered };
    if (child.status === "in-progress")
      return { status: "connected", durationSec: childDuration(), answered };
    return { status: "ended", durationSec: childDuration(), answered };
  }
  if (parent.status === "completed" || parent.status === "canceled")
    return { status: "ended", durationSec: childDuration(), answered };
  return { status: "failed", durationSec: childDuration(), answered };
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

/** Twilio over REST, with `fetch` injectable for tests. */
export class TwilioBridge implements CallBridge {
  private readonly fetchImpl: () => typeof fetch;

  constructor(
    private readonly keys: TwilioKeys,
    opts: { fetch?: typeof fetch } = {},
  ) {
    // Read at call time, so a test's stubbed global fetch is the one used.
    this.fetchImpl = () => opts.fetch ?? globalThis.fetch;
  }

  private account(path: string): string {
    return `${API}/Accounts/${encodeURIComponent(this.keys.accountSid)}/${path}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    form?: Record<string, string>,
    opts: { allow404?: boolean } = {},
  ): Promise<T | null> {
    const auth = Buffer.from(`${this.keys.apiKeySid}:${this.keys.apiKeySecret}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchImpl()(url, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: "application/json",
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
    } catch (err) {
      throw new CallBridgeError(
        `Twilio could not be reached: ${(err as Error).message ?? "network error"}`,
        0,
      );
    }
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
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

  async isVerified(phone: string): Promise<boolean> {
    const body = await this.request<{ outgoing_caller_ids?: Array<{ phone_number?: unknown }> }>(
      "GET",
      this.account(`OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(phone)}`),
    );
    return (body?.outgoing_caller_ids ?? []).some((c) => c.phone_number === phone);
  }

  async start(input: {
    memberPhone: string;
    prospectPhone: string;
    sayName: string | null;
    record: boolean;
  }): Promise<{ callSid: string }> {
    const body = await this.request<{ sid?: unknown }>("POST", this.account("Calls.json"), {
      To: input.memberPhone,
      From: input.memberPhone,
      Twiml: bridgeTwiml(input),
    });
    if (typeof body?.sid !== "string")
      throw new CallBridgeError("Twilio did not return a call", 502);
    return { callSid: body.sid };
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

  /** `canceled` ends a call still ringing, `completed` one in progress; one already over is left alone. */
  async hangUp(callSid: string): Promise<void> {
    const parent = await this.call(callSid);
    const status = RINGING.has(parent.status)
      ? "canceled"
      : parent.status === "in-progress"
        ? "completed"
        : null;
    if (!status) return;
    await this.request("POST", this.account(`Calls/${encodeURIComponent(callSid)}.json`), {
      Status: status,
    });
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

  async transcribe(input: {
    recordingSid: string;
    serviceSid: string;
  }): Promise<{ transcriptSid: string }> {
    const channel = {
      media_properties: { source_sid: input.recordingSid },
      participants: [
        { channel_participant: 1, role: "Agent" },
        { channel_participant: 2, role: "Customer" },
      ],
    };
    const body = await this.request<{ sid?: unknown }>("POST", `${INTELLIGENCE}/Transcripts`, {
      ServiceSid: input.serviceSid,
      Channel: JSON.stringify(channel),
    });
    if (typeof body?.sid !== "string")
      throw new CallBridgeError("Twilio did not return a transcript", 502);
    return { transcriptSid: body.sid };
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
  opts: { fetch?: typeof fetch } = {},
): CallBridge | null {
  const keys = twilioKeysFromEnv(env);
  return keys ? new TwilioBridge(keys, opts) : null;
}

/**
 * The transcription service to use: the workspace's configured one, else the
 * install's (kept in the shared database, as the provider account is
 * install-wide), else found or created on the account and kept.
 */
export async function resolveTranscriptionService(
  bridge: CallBridge,
  configured: string | null,
): Promise<string> {
  if (configured) return configured;
  const shared = getSharedDb();
  const kept = shared.installSetting(SERVICE_SETTING);
  if (kept) return kept;
  const sid = await bridge.ensureService();
  shared.setInstallSetting(SERVICE_SETTING, sid);
  return sid;
}
