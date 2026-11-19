import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION } from "../src/ledger-schema.ts";
import { getSharedDb, memberPhoneKey } from "../src/shared-db.ts";
import {
  ALREADY_VERIFIED_CODE,
  CallBridgeError,
  TRANSCRIPTION_SERVICE_NAME,
  TwilioBridge,
  HOLD_SECONDS,
  answeredByMachine,
  callBridgeFromEnv,
  dialTwiml,
  forgetTranscriptionService,
  holdTwiml,
  isMissingServiceError,
  mapBridgeStatus,
  resolveTranscriptionService,
  transcriptLines,
  twilioKeysFromEnv,
  xmlEscape,
} from "../src/call-bridge.ts";

// The Twilio bridge over a mocked fetch (no request leaves the process), the
// shared member phones, and migration v28.

const KEYS = { accountSid: "AC123", apiKeySid: "SK456", apiKeySecret: "s3cret" };
const ACCOUNT = "https://api.twilio.com/2010-04-01/Accounts/AC123";
const INTEL = "https://intelligence.twilio.com/v2";

interface Sent {
  method: string;
  url: string;
  form: Record<string, string>;
  auth: string | null;
}

/** A fetch that answers by "METHOD url" (prefix match), recording every request. */
function fakeFetch(routes: Record<string, (req: Sent) => { status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const headers = new Headers(init?.headers);
    const req = { method, url, form, auth: headers.get("authorization") };
    sent.push(req);
    const key = Object.keys(routes)
      .filter((k) => `${method} ${url}`.startsWith(k))
      .toSorted((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ message: "no route" }), { status: 500 });
    const out = routes[key]!(req);
    // A 204 carries no body, as Twilio's deletes answer.
    const status = out.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(out.body), { status });
  });
  return { fetch: fn as unknown as typeof fetch, sent };
}

describe("keys", () => {
  it("needs all three", () => {
    expect(twilioKeysFromEnv({})).toBeNull();
    expect(twilioKeysFromEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1" })).toBeNull();
    expect(
      twilioKeysFromEnv({
        TWILIO_ACCOUNT_SID: " AC1 ",
        TWILIO_API_KEY_SID: "SK1",
        TWILIO_API_KEY_SECRET: "x",
      }),
    ).toEqual({ accountSid: "AC1", apiKeySid: "SK1", apiKeySecret: "x" });
    expect(callBridgeFromEnv({})).toBeNull();
  });
});

describe("TwiML", () => {
  it("holds the member's leg after saying who is called, dialling nobody", () => {
    expect(holdTwiml("Dana at Acme")).toBe(
      `<Response><Say>Calling Dana at Acme</Say><Pause length="${HOLD_SECONDS}"/></Response>`,
    );
    expect(holdTwiml(null)).toBe(`<Response><Pause length="${HOLD_SECONDS}"/></Response>`);
    expect(holdTwiml("x")).not.toContain("<Dial");
  });

  it("dials from the member's number and records both channels", () => {
    expect(
      dialTwiml({ memberPhone: "+15550001111", prospectPhone: "+15126531187", record: true }),
    ).toBe(
      '<Response><Dial callerId="+15550001111" answerOnBridge="true" record="record-from-answer-dual"><Number>+15126531187</Number></Dial></Response>',
    );
  });

  it("escapes every value and leaves recording out when off", () => {
    expect(holdTwiml(`Dana "D" O'Neil at R&D <Labs>`)).toContain(
      "<Say>Calling Dana &quot;D&quot; O&apos;Neil at R&amp;D &lt;Labs&gt;</Say>",
    );
    const xml = dialTwiml({ memberPhone: '+1"><Hangup/>', prospectPhone: "+1<2>", record: false });
    expect(xml).toContain('callerId="+1&quot;&gt;&lt;Hangup/&gt;"');
    expect(xml).toContain("<Number>+1&lt;2&gt;</Number>");
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("<Hangup/>");
    expect(xmlEscape("a&b")).toBe("a&amp;b");
  });
});

const parent = (status: string, duration: string | null = null) => ({
  sid: "CA1",
  status,
  duration,
});
const child = (status: string, extra: Record<string, unknown> = {}) => ({
  sid: "CA2",
  status,
  ...extra,
});

describe("status mapping", () => {
  const now = new Date("2026-11-18T15:00:30Z");

  it("reads the member's leg, then the prospect's", () => {
    expect(mapBridgeStatus(parent("queued"), null, now).status).toBe("ringing_founder");
    expect(mapBridgeStatus(parent("ringing"), null, now).status).toBe("ringing_founder");
    expect(mapBridgeStatus(parent("in-progress"), null, now).status).toBe("ringing_prospect");
    expect(mapBridgeStatus(parent("in-progress"), child("ringing"), now).status).toBe(
      "ringing_prospect",
    );
    expect(
      mapBridgeStatus(
        parent("in-progress"),
        child("in-progress", { start_time: "Wed, 18 Nov 2026 15:00:00 +0000" }),
        now,
      ),
    ).toEqual({ status: "connected", durationSec: 30, answered: true, answeredBy: null });
    expect(
      mapBridgeStatus(parent("completed", "95"), child("completed", { duration: "80" }), now),
    ).toEqual({ status: "ended", durationSec: 80, answered: true, answeredBy: null });
    expect(mapBridgeStatus(parent("completed", "20"), child("no-answer"), now)).toEqual({
      status: "ended",
      durationSec: null,
      answered: false,
      answeredBy: null,
    });
    expect(
      mapBridgeStatus({ ...parent("in-progress"), answered_by: "machine_start" }, null, now)
        .answeredBy,
    ).toBe("machine_start");
    expect(mapBridgeStatus(parent("canceled"), null, now).status).toBe("ended");
    expect(mapBridgeStatus(parent("no-answer"), null, now).status).toBe("failed");
    expect(mapBridgeStatus(parent("busy"), null, now).status).toBe("failed");
    expect(mapBridgeStatus(parent("failed"), null, now).status).toBe("failed");
  });

  it("counts a voicemail or a fax as a machine, a person or an undecided detection as not", () => {
    for (const m of ["machine_start", "machine_end_beep", "machine", "fax"])
      expect(answeredByMachine(m)).toBe(true);
    for (const h of ["human", "unknown", null]) expect(answeredByMachine(h)).toBe(false);
  });
});

describe("TwilioBridge", () => {
  it("starts the member's leg with machine detection and the hold, then dials on connect", async () => {
    const { fetch, sent } = fakeFetch({
      [`POST ${ACCOUNT}/Calls.json`]: () => ({
        status: 201,
        body: { sid: "CA1", status: "queued" },
      }),
      [`POST ${ACCOUNT}/Calls/CA1.json`]: () => ({ body: { sid: "CA1", status: "in-progress" } }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    expect(await bridge.start({ memberPhone: "+15550001111", sayName: "Dana & co" })).toEqual({
      callSid: "CA1",
    });
    expect(sent[0]!.form).toEqual({
      To: "+15550001111",
      From: "+15550001111",
      MachineDetection: "Enable",
      Twiml: `<Response><Say>Calling Dana &amp; co</Say><Pause length="${HOLD_SECONDS}"/></Response>`,
    });
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("SK456:s3cret").toString("base64")}`);
    await bridge.connect("CA1", {
      memberPhone: "+15550001111",
      prospectPhone: "+15126531187",
      record: true,
    });
    expect(sent[1]!.form).toEqual({
      Twiml:
        '<Response><Dial callerId="+15550001111" answerOnBridge="true" record="record-from-answer-dual"><Number>+15126531187</Number></Dial></Response>',
    });
    expect(JSON.stringify(sent)).not.toMatch(/Url|StatusCallback/);
  });

  it("puts one deadline on the request and its body; a write that times out is uncertain", async () => {
    const hanging = (async (_url: string, init?: RequestInit) => {
      const signal = init!.signal!;
      // Headers arrive at once, the body never does: the deadline must cover the read.
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const bridge = new TwilioBridge(KEYS, { fetch: hanging, timeoutMs: 20 });
    const write = await bridge.start({ memberPhone: "+1555", sayName: null }).catch((e) => e);
    expect(write).toMatchObject({ uncertain: true, status: 0 });
    expect(write.message).toMatch(/may or may not/);
    const read = await bridge.status("CA1").catch((e) => e);
    expect(read).toMatchObject({ uncertain: false, status: 0 });
  });

  it("reads the parent and its child for the status", async () => {
    const { fetch, sent } = fakeFetch({
      [`GET ${ACCOUNT}/Calls/CA1.json`]: () => ({
        body: { sid: "CA1", status: "completed", duration: "70" },
      }),
      [`GET ${ACCOUNT}/Calls.json?ParentCallSid=CA1`]: () => ({
        body: { calls: [{ sid: "CA2", status: "completed", duration: "61" }] },
      }),
    });
    expect(await new TwilioBridge(KEYS, { fetch }).status("CA1")).toEqual({
      status: "ended",
      durationSec: 61,
      answered: true,
      answeredBy: null,
    });
    expect(sent.map((s) => s.url)).toEqual([
      `${ACCOUNT}/Calls/CA1.json`,
      `${ACCOUNT}/Calls.json?ParentCallSid=CA1`,
    ]);
  });

  it("hangs up a ringing call with canceled, a live one with completed, an ended one not at all", async () => {
    for (const [status, expected] of [
      ["ringing", "canceled"],
      ["in-progress", "completed"],
      ["completed", null],
    ] as const) {
      const { fetch, sent } = fakeFetch({
        [`GET ${ACCOUNT}/Calls/CA1.json`]: () => ({ body: { sid: "CA1", status } }),
        [`POST ${ACCOUNT}/Calls/CA1.json`]: () => ({ body: { sid: "CA1", status: "completed" } }),
      });
      await new TwilioBridge(KEYS, { fetch }).hangUp("CA1");
      const posts = sent.filter((s) => s.method === "POST");
      expect(posts.map((p) => p.form["Status"] ?? null)).toEqual(expected ? [expected] : []);
    }
  });

  it("reads the call again when a cancel is refused because it was answered meanwhile", async () => {
    let status = "ringing";
    const { fetch, sent } = fakeFetch({
      [`GET ${ACCOUNT}/Calls/CA1.json`]: () => ({ body: { sid: "CA1", status } }),
      [`POST ${ACCOUNT}/Calls/CA1.json`]: (req) => {
        if (req.form["Status"] === "canceled") {
          status = "in-progress";
          return { status: 400, body: { message: "Call is not ringing", code: 21220 } };
        }
        return { body: { sid: "CA1", status: "completed" } };
      },
    });
    await new TwilioBridge(KEYS, { fetch }).hangUp("CA1");
    expect(sent.filter((s) => s.method === "POST").map((p) => p.form["Status"])).toEqual([
      "canceled",
      "completed",
    ]);
  });

  it("verifies a caller ID and lists it", async () => {
    const { fetch, sent } = fakeFetch({
      [`POST ${ACCOUNT}/OutgoingCallerIds.json`]: () => ({
        status: 201,
        body: { validation_code: "123456", call_sid: "CA9", phone_number: "+15550001111" },
      }),
      [`GET ${ACCOUNT}/OutgoingCallerIds.json?PhoneNumber=%2B15550001111`]: () => ({
        body: { outgoing_caller_ids: [{ sid: "PN1", phone_number: "+15550001111" }] },
      }),
      [`GET ${ACCOUNT}/OutgoingCallerIds.json?PhoneNumber=%2B15550002222`]: () => ({
        body: { outgoing_caller_ids: [] },
      }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    expect(await bridge.verifyCallerId("+15550001111")).toEqual({ validationCode: "123456" });
    expect(sent[0]!.form).toMatchObject({ PhoneNumber: "+15550001111" });
    expect(await bridge.isVerified("+15550001111")).toBe(true);
    expect(await bridge.isVerified("+15550002222")).toBe(false);
  });

  it("removes a caller ID by its SID, and nothing when the number is not one", async () => {
    const { fetch, sent } = fakeFetch({
      [`GET ${ACCOUNT}/OutgoingCallerIds.json?PhoneNumber=%2B15550001111`]: () => ({
        body: { outgoing_caller_ids: [{ sid: "PN1", phone_number: "+15550001111" }] },
      }),
      [`GET ${ACCOUNT}/OutgoingCallerIds.json?PhoneNumber=%2B15550002222`]: () => ({
        body: { outgoing_caller_ids: [] },
      }),
      [`DELETE ${ACCOUNT}/OutgoingCallerIds/PN1.json`]: () => ({ status: 204, body: null }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    await bridge.removeCallerId("+15550001111");
    await bridge.removeCallerId("+15550002222");
    expect(sent.filter((s) => s.method === "DELETE").map((s) => s.url)).toEqual([
      `${ACCOUNT}/OutgoingCallerIds/PN1.json`,
    ]);
  });

  it("deletes a recording and a transcript, a missing one being fine", async () => {
    const { fetch, sent } = fakeFetch({
      [`DELETE ${ACCOUNT}/Recordings/RE1.json`]: () => ({ status: 204, body: null }),
      [`DELETE ${INTEL}/Transcripts/GT1`]: () => ({ status: 404, body: { message: "gone" } }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    await bridge.deleteRecording("RE1");
    await bridge.deleteTranscript("GT1");
    expect(sent.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("throws the provider's message and code", async () => {
    const { fetch } = fakeFetch({
      [`POST ${ACCOUNT}/OutgoingCallerIds.json`]: () => ({
        status: 400,
        body: { code: ALREADY_VERIFIED_CODE, message: "Phone number is already verified." },
      }),
    });
    const err = await new TwilioBridge(KEYS, { fetch }).verifyCallerId("+1555").catch((e) => e);
    expect(err).toBeInstanceOf(CallBridgeError);
    expect(err).toMatchObject({
      status: 400,
      code: ALREADY_VERIFIED_CODE,
      message: "Twilio: Phone number is already verified.",
    });
    const down = new TwilioBridge(KEYS, {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(down.status("CA1")).rejects.toMatchObject({ status: 0 });
  });

  it("finds the recording by the parent call", async () => {
    const { fetch } = fakeFetch({
      [`GET ${ACCOUNT}/Recordings.json?CallSid=CA1`]: () => ({
        body: { recordings: [{ sid: "RE1", status: "completed", duration: "61", channels: 2 }] },
      }),
      [`GET ${ACCOUNT}/Recordings.json?CallSid=CA2`]: () => ({ body: { recordings: [] } }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    expect(await bridge.recording("CA1")).toEqual({
      sid: "RE1",
      status: "completed",
      durationSec: 61,
    });
    expect(await bridge.recording("CA2")).toBeNull();
  });

  it("finds the transcription service by name, else creates it", async () => {
    const found = fakeFetch({
      [`GET ${INTEL}/Services/${TRANSCRIPTION_SERVICE_NAME}`]: () => ({ body: { sid: "GA1" } }),
    });
    expect(await new TwilioBridge(KEYS, { fetch: found.fetch }).ensureService()).toBe("GA1");
    expect(found.sent.filter((s) => s.method === "POST")).toEqual([]);

    const created = fakeFetch({
      [`GET ${INTEL}/Services/${TRANSCRIPTION_SERVICE_NAME}`]: () => ({
        status: 404,
        body: { message: "not found" },
      }),
      [`POST ${INTEL}/Services`]: () => ({ status: 201, body: { sid: "GA2" } }),
    });
    expect(await new TwilioBridge(KEYS, { fetch: created.fetch }).ensureService()).toBe("GA2");
    expect(created.sent.at(-1)!.form).toMatchObject({ UniqueName: TRANSCRIPTION_SERVICE_NAME });

    // Another workspace created it between the lookup and the create.
    let lookups = 0;
    const raced = fakeFetch({
      [`GET ${INTEL}/Services/${TRANSCRIPTION_SERVICE_NAME}`]: () =>
        ++lookups === 1 ? { status: 404, body: {} } : { body: { sid: "GA3" } },
      [`POST ${INTEL}/Services`]: () => ({ status: 409, body: { message: "UniqueName taken" } }),
    });
    expect(await new TwilioBridge(KEYS, { fetch: raced.fetch }).ensureService()).toBe("GA3");
  });

  it("transcribes the recording with channel 1 as the member and 2 as the prospect", async () => {
    const { fetch, sent } = fakeFetch({
      [`GET ${INTEL}/Transcripts?SourceSid=RE1`]: () => ({ body: { transcripts: [] } }),
      [`POST ${INTEL}/Transcripts`]: () => ({
        status: 201,
        body: { sid: "GT1", status: "queued" },
      }),
    });
    expect(
      await new TwilioBridge(KEYS, { fetch }).transcribe({
        recordingSid: "RE1",
        serviceSid: "GA1",
      }),
    ).toEqual({ transcriptSid: "GT1" });
    const create = sent.find((s) => s.method === "POST")!;
    expect(create.form["ServiceSid"]).toBe("GA1");
    expect(JSON.parse(create.form["Channel"]!)).toEqual({
      media_properties: { source_sid: "RE1" },
      participants: [
        { channel_participant: 1, role: "Agent" },
        { channel_participant: 2, role: "Customer" },
      ],
    });
  });

  it("reuses the recording's transcript instead of making a second one", async () => {
    const existing = fakeFetch({
      [`GET ${INTEL}/Transcripts?SourceSid=RE1`]: () => ({
        body: { transcripts: [{ sid: "GT7" }] },
      }),
    });
    expect(
      await new TwilioBridge(KEYS, { fetch: existing.fetch }).transcribe({
        recordingSid: "RE1",
        serviceSid: "GA1",
      }),
    ).toEqual({ transcriptSid: "GT7" });
    expect(existing.sent.filter((s) => s.method === "POST")).toEqual([]);

    // The create failed (or timed out) after Twilio made it: the list finds it.
    let lists = 0;
    const raced = fakeFetch({
      [`GET ${INTEL}/Transcripts?SourceSid=RE1`]: () => ({
        body: { transcripts: ++lists === 1 ? [] : [{ sid: "GT8" }] },
      }),
      [`POST ${INTEL}/Transcripts`]: () => ({ status: 500, body: { message: "oops" } }),
    });
    expect(
      await new TwilioBridge(KEYS, { fetch: raced.fetch }).transcribe({
        recordingSid: "RE1",
        serviceSid: "GA1",
      }),
    ).toEqual({ transcriptSid: "GT8" });

    const refused = fakeFetch({
      [`GET ${INTEL}/Transcripts?SourceSid=RE1`]: () => ({ body: { transcripts: [] } }),
      [`POST ${INTEL}/Transcripts`]: () => ({ status: 400, body: { message: "too short" } }),
    });
    await expect(
      new TwilioBridge(KEYS, { fetch: refused.fetch }).transcribe({
        recordingSid: "RE1",
        serviceSid: "GA1",
      }),
    ).rejects.toMatchObject({ message: "Twilio: too short" });
  });

  it("polls the transcript, then reads its sentences across pages with speaker labels", async () => {
    let status = "in-progress";
    const { fetch } = fakeFetch({
      [`GET ${INTEL}/Transcripts/GT1`]: () => ({ body: { sid: "GT1", status } }),
      [`GET ${INTEL}/Transcripts/GT1/Sentences?PageSize=1000`]: () => ({
        body: {
          sentences: [
            {
              media_channel: 2,
              sentence_index: 1,
              start_time: "2.4",
              transcript: "Hi, who's this?",
            },
            { media_channel: 1, sentence_index: 0, start_time: "0.5", transcript: "Hello Dana." },
          ],
          meta: { next_page_url: `${INTEL}/Transcripts/GT1/Sentences?PageSize=1000&Page=1` },
        },
      }),
      [`GET ${INTEL}/Transcripts/GT1/Sentences?PageSize=1000&Page=1`]: () => ({
        body: {
          sentences: [
            { media_channel: 1, sentence_index: 2, start_time: 4.04, transcript: " Sam  here. " },
            { media_channel: 2, sentence_index: 3, start_time: null, transcript: "" },
          ],
          meta: { next_page_url: null },
        },
      }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    expect(await bridge.transcript("GT1")).toEqual({ status: "pending" });
    status = "completed";
    expect(await bridge.transcript("GT1")).toEqual({
      status: "ready",
      lines: [
        { speaker: "founder", text: "Hello Dana.", startSec: 0.5 },
        { speaker: "prospect", text: "Hi, who's this?", startSec: 2.4 },
        { speaker: "founder", text: "Sam here.", startSec: 4 },
      ],
    });
    status = "failed";
    expect(await bridge.transcript("GT1")).toEqual({ status: "failed" });
    expect(transcriptLines([])).toEqual([]);
  });
});

describe("member phones and the install's service", () => {
  beforeEach(() => {
    const db = getSharedDb();
    db.deleteMemberPhone("");
    db.deleteMemberPhone("mia@example.com");
  });

  it("keys members by email, '' for the local owner, and round-trips a phone", () => {
    expect(memberPhoneKey(null)).toBe("");
    expect(memberPhoneKey(" Mia@Example.com ")).toBe("mia@example.com");
    const db = getSharedDb();
    expect(db.memberPhone("")).toBeNull();
    db.setMemberPhone({
      member: "",
      phone: "+15550001111",
      status: "verifying",
      validationCode: "1",
    });
    db.setMemberPhone({
      member: "mia@example.com",
      phone: "+15550002222",
      status: "failed",
      error: "x",
    });
    expect(db.memberPhone("")).toMatchObject({ phone: "+15550001111", validation_code: "1" });
    db.setMemberPhone({ member: "", phone: "+15550001111", status: "verified", verifiedAt: "t" });
    expect(db.memberPhone("")).toMatchObject({
      status: "verified",
      validation_code: null,
      verified_at: "t",
    });
    expect(db.memberPhone("mia@example.com")?.error).toBe("x");
    expect(db.deleteMemberPhone("")).toBe(true);
    expect(db.deleteMemberPhone("")).toBe(false);
  });

  it("keeps the transcription service install-wide: configured, else kept, else ensured once", async () => {
    getSharedDb().setInstallSetting("calls.transcriptionServiceSid", "GAlegacy");
    const ensureService = vi.fn(async () => "GA9");
    const bridge = { accountSid: "AC1", ensureService } as unknown as TwilioBridge;
    expect(await resolveTranscriptionService(bridge, "GAconfig")).toBe("GAconfig");
    expect(ensureService).not.toHaveBeenCalled();
    // A value kept without its account is not trusted.
    expect(await resolveTranscriptionService(bridge, null)).toBe("GA9");
    expect(await resolveTranscriptionService(bridge, null)).toBe("GA9");
    expect(ensureService).toHaveBeenCalledTimes(1);
    expect(JSON.parse(getSharedDb().installSetting("calls.transcriptionServiceSid")!)).toEqual({
      accountSid: "AC1",
      sid: "GA9",
    });
    // Keys for another account get that account's service, which replaces the kept one.
    const other = {
      accountSid: "AC2",
      ensureService: vi.fn(async () => "GA2"),
    } as unknown as TwilioBridge;
    expect(await resolveTranscriptionService(other, null)).toBe("GA2");
    expect(JSON.parse(getSharedDb().installSetting("calls.transcriptionServiceSid")!)).toEqual({
      accountSid: "AC2",
      sid: "GA2",
    });
  });

  it("lists who holds a phone, past failed attempts", () => {
    const db = getSharedDb();
    db.setMemberPhone({ member: "", phone: "+15550009999", status: "verified" });
    db.setMemberPhone({ member: "mia@example.com", phone: "+15550009999", status: "failed" });
    expect(db.memberPhoneHolders("+15550009999")).toEqual([""]);
    expect(db.memberPhoneHolders("+15550000000")).toEqual([]);
  });
});

describe("migration v28", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(tmpdir(), `oneshot-gtm-test-v28-${Date.now()}-${Math.random()}.sqlite`);
  });
  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  it("adds member, status and transcript_sid to a v27 ledger's calls and keeps its rows", () => {
    expect(LEDGER_MIGRATIONS.find((m) => m.name === "calls-bridge")?.version).toBe(28);
    expect(LEDGER_SCHEMA_VERSION).toBe(32);
    const first = new Ledger(dbPath);
    const id = first.upsertProspect({ name: "Dana", email: "d@a.test" });
    first.close();
    const raw = new Database(dbPath);
    for (const col of [
      "member",
      "status",
      "transcript_sid",
      "status_reason",
      "member_phone",
      "bridged_at",
      "commitments_json",
      "discard_recording",
    ])
      raw.exec(`ALTER TABLE calls DROP COLUMN ${col}`);
    raw
      .prepare(
        "INSERT INTO calls (prospect_id, started_at, outcome, provider) VALUES (?, ?, 'no_answer', 'tel')",
      )
      .run(id, "2026-11-17T10:00:00Z");
    raw.exec("PRAGMA user_version = 27");
    raw.close();

    const ledger = new Ledger(dbPath);
    try {
      const check = new Database(dbPath, { readonly: true });
      const cols = (check.query("PRAGMA table_info(calls)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      check.close();
      expect(cols).toEqual(
        expect.arrayContaining([
          "member",
          "status",
          "transcript_sid",
          "status_reason",
          "member_phone",
          "bridged_at",
          "commitments_json",
          "discard_recording",
        ]),
      );
      expect(ledger.listCallsForProspect(id)).toEqual([
        expect.objectContaining({ outcome: "no_answer", member: null, provider: "tel" }),
      ]);
      expect(ledger.listCallsForProspect(id)[0]).not.toHaveProperty("status");
      const bridged = ledger.insertCall({
        prospectId: id,
        startedAt: "2026-11-18T10:00:00Z",
        provider: "twilio",
        providerCallSid: "CA1",
        member: "mia@example.com",
        status: "ringing_founder",
        transcriptStatus: "pending",
      });
      expect(ledger.getCall(bridged)).toMatchObject({
        member: "mia@example.com",
        status: "ringing_founder",
        transcriptStatus: "pending",
      });
      // Exactly one claim wins the hold.
      expect(ledger.claimBridge(bridged, "2026-11-18T10:00:05Z")).toBe(true);
      expect(ledger.claimBridge(bridged, "2026-11-18T10:00:06Z")).toBe(false);
      ledger.updateBridgedCall(bridged, { status: "ended", durationSec: 42, transcriptSid: "GT1" });
      expect(ledger.getBridgedCall(bridged)).toMatchObject({
        callSid: "CA1",
        transcriptSid: "GT1",
        view: expect.objectContaining({ status: "ended", durationSec: 42 }),
      });
    } finally {
      ledger.close();
    }
  });
});

describe("migration v29", () => {
  it("adds the recording columns to a v28 ledger", () => {
    const dbPath = join(tmpdir(), `oneshot-gtm-test-v29-${Date.now()}-${Math.random()}.sqlite`);
    try {
      new Ledger(dbPath).close();
      const raw = new Database(dbPath);
      for (const col of ["recording_from", "recording_requested_at", "discard_next_at"])
        raw.exec(`ALTER TABLE calls DROP COLUMN ${col}`);
      raw.exec("PRAGMA user_version = 28");
      raw.close();
      new Ledger(dbPath).close();
      const check = new Database(dbPath, { readonly: true });
      const cols = (check.query("PRAGMA table_info(calls)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      check.close();
      expect(cols).toEqual(
        expect.arrayContaining(["recording_from", "recording_requested_at", "discard_next_at"]),
      );
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});

describe("bridged call rows", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => ledger.close());

  const bridged = (prospectId: number) =>
    ledger.insertCall({
      prospectId,
      startedAt: "2026-11-18T10:00:00Z",
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
      transcriptStatus: "pending",
    });
  const toAdvance = () =>
    ledger.listBridgedCallsToAdvance("2026-11-17T00:00:00Z", 10).map((c) => c.view.id);

  it("does not pick an empty ready transcript up again", () => {
    const id = bridged(ledger.upsertProspect({ name: "Dana", email: "d@a.test" }));
    ledger.updateBridgedCall(id, { transcript: [], transcriptStatus: "ready" });
    expect(toAdvance()).toEqual([]);
    ledger.updateBridgedCall(id, {
      transcript: [{ speaker: "prospect", text: "Hi", startSec: 0 }],
    });
    expect(toAdvance()).toEqual([id]);
  });

  it("keeps a declined recording out: transcript writes are dropped until it is deleted", () => {
    const id = bridged(ledger.upsertProspect({ name: "Dana", email: "d@a.test" }));
    ledger.updateBridgedCall(id, {
      recordingSid: "RE1",
      transcript: [{ speaker: "prospect", text: "Hi", startSec: 0 }],
      transcriptStatus: "ready",
    });
    ledger.markRecordingDiscard(id);
    expect(ledger.getCall(id)).toMatchObject({ transcriptStatus: "none", transcript: null });
    ledger.updateBridgedCall(id, {
      status: "failed",
      transcript: [{ speaker: "prospect", text: "late", startSec: 0 }],
      transcriptStatus: "ready",
    });
    expect(ledger.getCall(id)).toMatchObject({
      status: "failed",
      transcriptStatus: "none",
      transcript: null,
    });
    expect(ledger.getBridgedCall(id)).toMatchObject({ discardPending: true, recordingSid: "RE1" });
    expect(toAdvance()).toEqual([id]);
    ledger.finishRecordingDiscard(id);
    expect(ledger.getBridgedCall(id)).toMatchObject({ discardPending: false, recordingSid: null });
    expect(toAdvance()).toEqual([]);
  });

  it("stores the promises the member confirmed, keeping them when a later log sends none", () => {
    const prospectId = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const id = bridged(prospectId);
    ledger.setCallOutcome({ id, prospectId, outcome: "interested", commitments: ["send terms"] });
    expect(ledger.getCall(id)?.commitments).toEqual(["send terms"]);
    ledger.setCallOutcome({ id, prospectId, outcome: "meeting_booked" });
    expect(ledger.getCall(id)?.commitments).toEqual(["send terms"]);
    ledger.setCallOutcome({ id, prospectId, outcome: "meeting_booked", commitments: [] });
    expect(ledger.getCall(id)?.commitments).toEqual([]);
    expect(ledger.getCall(bridged(prospectId))).not.toHaveProperty("commitments");
  });
});

/** Headers arrive, then the connection resets before the body is read. */
const resetting = (status: number) =>
  (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("Connection reset by peer"));
        },
      }),
      { status },
    )) as unknown as typeof fetch;

describe("recording consent and uncertain writes", () => {
  it("treats an accepted write whose answer was lost, or that names no call, as uncertain", async () => {
    const lost = new TwilioBridge(KEYS, { fetch: resetting(201) });
    expect(await lost.start({ memberPhone: "+1555", sayName: null }).catch((e) => e)).toMatchObject(
      { uncertain: true, status: 0 },
    );
    expect(await lost.status("CA1").catch((e) => e)).toMatchObject({ uncertain: false });
    const refused = new TwilioBridge(KEYS, { fetch: resetting(400) });
    expect(
      await refused.start({ memberPhone: "+1555", sayName: null }).catch((e) => e),
    ).toMatchObject({ uncertain: false });
    const { fetch } = fakeFetch({ [`POST ${ACCOUNT}/Calls.json`]: () => ({ body: {} }) });
    expect(
      await new TwilioBridge(KEYS, { fetch })
        .start({ memberPhone: "+1555", sayName: null })
        .catch((e) => e),
    ).toMatchObject({ uncertain: true, status: 502 });
  });

  it("records a connected call on two channels through the parent call", async () => {
    const { fetch, sent } = fakeFetch({
      [`POST ${ACCOUNT}/Calls/CA1/Recordings.json`]: () => ({
        status: 201,
        body: { sid: "RE1", status: "in-progress" },
      }),
    });
    await new TwilioBridge(KEYS, { fetch }).startRecording("CA1");
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        url: `${ACCOUNT}/Calls/CA1/Recordings.json`,
        form: { RecordingChannels: "dual" },
      }),
    ]);
  });

  it("knows a missing service and forgets only the kept one it names", () => {
    expect(isMissingServiceError(new CallBridgeError("Twilio: not found", 404))).toBe(true);
    expect(isMissingServiceError(new CallBridgeError("x", 400, 20404))).toBe(true);
    expect(
      isMissingServiceError(new CallBridgeError("Twilio: Service GA1 does not exist", 400)),
    ).toBe(true);
    expect(isMissingServiceError(new CallBridgeError("Twilio: rate limited", 429))).toBe(false);
    expect(isMissingServiceError(new Error("not found"))).toBe(false);
    const db = getSharedDb();
    db.setInstallSetting(
      "calls.transcriptionServiceSid",
      JSON.stringify({ accountSid: "AC1", sid: "GAold" }),
    );
    forgetTranscriptionService("GAother");
    expect(db.installSetting("calls.transcriptionServiceSid")).toContain("GAold");
    forgetTranscriptionService("GAold");
    expect(db.installSetting("calls.transcriptionServiceSid")).toBe("null");
  });

  it("removes a member's phone only as it was read", () => {
    const db = getSharedDb();
    const old = db.setMemberPhone({ member: "", phone: "+15550001111", status: "verified" });
    db.setMemberPhone({ member: "", phone: "+15550002222", status: "verifying" });
    expect(db.deleteMemberPhone("", old)).toBe(false);
    expect(db.memberPhone("")?.phone).toBe("+15550002222");
    expect(db.deleteMemberPhone("", db.memberPhone("")!)).toBe(true);
  });
});

describe("bridged call recording rows", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => ledger.close());

  const call = (prospectId: number, startedAt: string, transcriptStatus: "none" | "pending") =>
    ledger.insertCall({
      prospectId,
      startedAt,
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
      transcriptStatus,
    });

  it("lets one Record press claim an unrecorded call, never a declined one", () => {
    const p = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const id = call(p, "2026-11-18T10:00:00Z", "none");
    expect(ledger.claimRecording(id, "2026-11-18T10:01:00Z")).toBe(true);
    expect(ledger.claimRecording(id, "2026-11-18T10:01:01Z")).toBe(false);
    expect(ledger.getCall(id)?.transcriptStatus).toBe("pending");
    const declined = call(p, "2026-11-18T10:00:00Z", "none");
    ledger.markRecordingDiscard(declined);
    expect(ledger.claimRecording(declined, "2026-11-18T10:01:00Z")).toBe(false);
  });

  it("drops the promises with a declined recording", () => {
    const prospectId = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const id = call(prospectId, "2026-11-18T10:00:00Z", "pending");
    ledger.setCallOutcome({ id, prospectId, outcome: "interested", commitments: ["send terms"] });
    ledger.markRecordingDiscard(id);
    expect(ledger.getCall(id)).not.toHaveProperty("commitments");
    ledger.setCallOutcome({ id, prospectId, outcome: "interested" });
    expect(ledger.getCall(id)).not.toHaveProperty("commitments");
  });

  it("keeps a pending deletion in the sweep past its lookback, with its own limit", () => {
    const p = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const old = [1, 2, 3].map(() => call(p, "2026-11-01T10:00:00Z", "pending"));
    for (const id of old) ledger.markRecordingDiscard(id);
    const fresh = call(p, "2026-11-18T10:00:00Z", "pending");
    const listed = (limit: number, discards?: number) =>
      ledger
        .listBridgedCallsToAdvance("2026-11-17T00:00:00Z", limit, discards)
        .map((c) => c.view.id);
    expect(listed(10)).toEqual([...old, fresh]);
    expect(listed(1, 2)).toEqual([old[0], old[1], fresh]);
    ledger.finishRecordingDiscard(old[0]!);
    expect(listed(10)).toEqual([old[1], old[2], fresh]);
  });
});

/** A fetch that fails before any response, the way a network error does. */
const throwing = (err: unknown) =>
  (async () => {
    throw err;
  }) as unknown as typeof fetch;

describe("writes that may have reached Twilio", () => {
  it("treats a reset before the headers as uncertain, a connection never opened as refused", async () => {
    const reset = Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
    const write = (fetchImpl: typeof fetch) =>
      new TwilioBridge(KEYS, { fetch: fetchImpl }).startRecording("CA1").catch((e) => e);
    expect(await write(throwing(reset))).toMatchObject({ uncertain: true });
    const refused = Object.assign(new TypeError("refused"), { code: "ConnectionRefused" });
    expect(await write(throwing(refused))).toMatchObject({ uncertain: false, status: 0 });
    const dns = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(await write(throwing(dns))).toMatchObject({ uncertain: false });
    // A read is never uncertain: nothing changed.
    expect(
      await new TwilioBridge(KEYS, { fetch: throwing(reset) }).status("CA1").catch((e) => e),
    ).toMatchObject({ uncertain: false });
  });
});

describe("recording rows over time", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => ledger.close());

  const call = (prospectId: number, startedAt: string) =>
    ledger.insertCall({
      prospectId,
      startedAt,
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
      transcriptStatus: "none",
    });

  it("never writes back promises after the recording was declined", () => {
    const prospectId = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const id = call(prospectId, "2026-11-18T10:00:00Z");
    ledger.markRecordingDiscard(id);
    ledger.setCallOutcome({ id, prospectId, outcome: "interested", commitments: ["send terms"] });
    expect(ledger.getCall(id)).toMatchObject({ outcome: "interested", discard: "pending" });
    expect(ledger.getCall(id)).not.toHaveProperty("commitments");
  });

  it("starts the give-up window when the recording was asked for, not when the call began", () => {
    const p = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const long = call(p, "2026-11-18T00:00:00Z");
    expect(ledger.claimRecording(long, "2026-11-18T07:00:00Z")).toBe(true);
    expect(ledger.getCall(long)).toMatchObject({
      transcriptStatus: "pending",
      recordedFrom: "consent",
    });
    expect(ledger.failStaleTranscripts("2026-11-18T06:30:00Z")).toBe(0);
    expect(ledger.failStaleTranscripts("2026-11-18T13:30:00Z")).toBe(1);
  });

  it("lets Record be pressed again after a sure refusal", () => {
    const p = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const id = call(p, "2026-11-18T10:00:00Z");
    ledger.claimRecording(id, "2026-11-18T10:01:00Z");
    ledger.releaseRecording(id);
    expect(ledger.getCall(id)?.transcriptStatus).toBe("none");
    expect(ledger.getCall(id)).not.toHaveProperty("recordedFrom");
    expect(ledger.claimRecording(id, "2026-11-18T10:02:00Z")).toBe(true);
  });

  it("leaves a deferred deletion out of the sweep until it is due", () => {
    const p = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    const id = call(p, "2026-11-01T10:00:00Z");
    ledger.markRecordingDiscard(id);
    ledger.deferDiscard(id, "2026-11-18T12:00:00Z");
    const listed = (now: string, onlyDiscards = false) =>
      ledger
        .listBridgedCallsToAdvance("2026-11-17T00:00:00Z", 10, 5, now, onlyDiscards)
        .map((c) => c.view.id);
    expect(listed("2026-11-18T11:00:00Z")).toEqual([]);
    expect(listed("2026-11-18T12:00:00Z")).toEqual([id]);
    const recent = ledger.insertCall({
      prospectId: p,
      startedAt: "2026-11-18T10:00:00Z",
      provider: "twilio",
      providerCallSid: "CA2",
      status: "ended",
      transcriptStatus: "pending",
    });
    // Calls off: the pending transcript waits, the deletion does not.
    expect(listed("2026-11-18T12:00:00Z", true)).toEqual([id]);
    expect(listed("2026-11-18T12:00:00Z")).toEqual([id, recent]);
  });
});

describe("writes that must not undo a newer state", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => ledger.close());

  const call = (prospectId: number) =>
    ledger.insertCall({
      prospectId,
      startedAt: "2026-11-18T10:00:00Z",
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ringing_founder",
      transcriptStatus: "pending",
    });

  it("never puts a live status over an ended one", () => {
    const id = call(ledger.upsertProspect({ name: "Dana", email: "d@a.test" }));
    ledger.updateBridgedCall(id, { status: "ended", durationSec: 30 });
    ledger.updateBridgedCall(id, { status: "connected", durationSec: 5 });
    expect(ledger.getCall(id)).toMatchObject({ status: "ended", durationSec: 30 });
    ledger.updateBridgedCall(id, { status: "failed" });
    expect(ledger.getCall(id)?.status).toBe("failed");
  });

  it("writes the hold's own reads only while no poll has claimed the call", () => {
    const id = call(ledger.upsertProspect({ name: "Dana", email: "d@a.test" }));
    ledger.updateUnclaimedCall(id, { status: "ringing_founder" });
    ledger.claimBridge(id, "2026-11-18T10:00:05Z");
    ledger.updateBridgedCall(id, { status: "connected" });
    ledger.updateUnclaimedCall(id, {
      status: "ended",
      statusReason: "x",
      transcriptStatus: "none",
    });
    expect(ledger.getCall(id)).toMatchObject({ status: "connected", transcriptStatus: "pending" });
  });
});

describe("member phone rows", () => {
  beforeEach(() => {
    const db = getSharedDb();
    db.deleteMemberPhone("");
    db.deleteMemberPhone("mia@example.com");
    db.deleteMemberPhone("lee@example.com");
  });

  it("acts on a read row only by its write token", () => {
    const db = getSharedDb();
    const first = db.setMemberPhone({ member: "", phone: "+15550001111", status: "verifying" });
    const second = db.setMemberPhone({ member: "", phone: "+15550001111", status: "verifying" });
    expect(first.write_token).not.toBe(second.write_token);
    expect(
      db.setMemberPhone(
        { member: "", phone: "+15550001111", status: "verified" },
        first.write_token!,
      ),
    ).toBeNull();
    expect(db.memberPhone("")?.status).toBe("verifying");
    expect(db.deleteMemberPhone("", first)).toBe(false);
    expect(db.deleteMemberPhone("", second)).toBe(true);
  });

  it("never keeps two verified rows for one number, and a removed member must verify again", () => {
    const db = getSharedDb();
    db.addMember({ email: "mia@example.com", role: "member" });
    db.addMember({ email: "lee@example.com", role: "member" });
    try {
      db.setMemberPhone({ member: "mia@example.com", phone: "+15550002222", status: "verified" });
      db.removeMember("mia@example.com");
      expect(db.memberPhone("mia@example.com")?.status).toBe("failed");
      db.setMemberPhone({ member: "mia@example.com", phone: "+15550002222", status: "verified" });
      db.setMemberPhone({ member: "lee@example.com", phone: "+15550002222", status: "verified" });
      expect(db.memberPhone("mia@example.com")?.status).toBe("failed");
      expect(db.memberPhone("lee@example.com")?.status).toBe("verified");
    } finally {
      db.removeMember("lee@example.com");
      db.removeMember("mia@example.com");
    }
  });
});
