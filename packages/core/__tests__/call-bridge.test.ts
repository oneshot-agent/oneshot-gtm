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
  holdTwiml,
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
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
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
    expect(LEDGER_SCHEMA_VERSION).toBe(28);
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
