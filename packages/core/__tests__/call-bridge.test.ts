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
  bridgeTwiml,
  callBridgeFromEnv,
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
  it("says who is called, dials from the member's number, and records both channels", () => {
    expect(
      bridgeTwiml({
        memberPhone: "+15550001111",
        prospectPhone: "+15126531187",
        sayName: "Dana at Acme",
        record: true,
      }),
    ).toBe(
      '<Response><Say>Calling Dana at Acme</Say><Dial callerId="+15550001111" answerOnBridge="true" record="record-from-answer-dual"><Number>+15126531187</Number></Dial></Response>',
    );
  });

  it("escapes every value and leaves recording out when off", () => {
    const xml = bridgeTwiml({
      memberPhone: '+1"><Hangup/>',
      prospectPhone: "+1<2>",
      sayName: `Dana "D" O'Neil at R&D <Labs>`,
      record: false,
    });
    expect(xml).toContain(
      "<Say>Calling Dana &quot;D&quot; O&apos;Neil at R&amp;D &lt;Labs&gt;</Say>",
    );
    expect(xml).toContain('callerId="+1&quot;&gt;&lt;Hangup/&gt;"');
    expect(xml).toContain("<Number>+1&lt;2&gt;</Number>");
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("<Hangup/>");
    expect(
      bridgeTwiml({ memberPhone: "+1", prospectPhone: "+2", sayName: null, record: false }),
    ).toBe(
      '<Response><Dial callerId="+1" answerOnBridge="true"><Number>+2</Number></Dial></Response>',
    );
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
    ).toEqual({ status: "connected", durationSec: 30, answered: true });
    expect(
      mapBridgeStatus(parent("completed", "95"), child("completed", { duration: "80" }), now),
    ).toEqual({ status: "ended", durationSec: 80, answered: true });
    expect(mapBridgeStatus(parent("completed", "20"), child("no-answer"), now)).toEqual({
      status: "ended",
      durationSec: null,
      answered: false,
    });
    expect(mapBridgeStatus(parent("canceled"), null, now).status).toBe("ended");
    expect(mapBridgeStatus(parent("no-answer"), null, now).status).toBe("failed");
    expect(mapBridgeStatus(parent("busy"), null, now).status).toBe("failed");
    expect(mapBridgeStatus(parent("failed"), null, now).status).toBe("failed");
  });
});

describe("TwilioBridge", () => {
  it("starts a call with To and From the member's phone and the TwiML inline, on Basic auth", async () => {
    const { fetch, sent } = fakeFetch({
      [`POST ${ACCOUNT}/Calls.json`]: () => ({
        status: 201,
        body: { sid: "CA1", status: "queued" },
      }),
    });
    const bridge = new TwilioBridge(KEYS, { fetch });
    expect(
      await bridge.start({
        memberPhone: "+15550001111",
        prospectPhone: "+15126531187",
        sayName: "Dana & co",
        record: true,
      }),
    ).toEqual({ callSid: "CA1" });
    expect(sent[0]!.form).toEqual({
      To: "+15550001111",
      From: "+15550001111",
      Twiml:
        '<Response><Say>Calling Dana &amp; co</Say><Dial callerId="+15550001111" answerOnBridge="true" record="record-from-answer-dual"><Number>+15126531187</Number></Dial></Response>',
    });
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("SK456:s3cret").toString("base64")}`);
    expect(JSON.stringify(sent)).not.toMatch(/Url|StatusCallback/);
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
    expect(sent[0]!.form["ServiceSid"]).toBe("GA1");
    expect(JSON.parse(sent[0]!.form["Channel"]!)).toEqual({
      media_properties: { source_sid: "RE1" },
      participants: [
        { channel_participant: 1, role: "Agent" },
        { channel_participant: 2, role: "Customer" },
      ],
    });
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
    const ensureService = vi.fn(async () => "GA9");
    const bridge = { ensureService } as unknown as TwilioBridge;
    expect(await resolveTranscriptionService(bridge, "GAconfig")).toBe("GAconfig");
    expect(ensureService).not.toHaveBeenCalled();
    expect(await resolveTranscriptionService(bridge, null)).toBe("GA9");
    expect(await resolveTranscriptionService(bridge, null)).toBe("GA9");
    expect(ensureService).toHaveBeenCalledTimes(1);
    expect(getSharedDb().installSetting("calls.transcriptionServiceSid")).toBe("GA9");
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
    for (const col of ["member", "status", "transcript_sid"])
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
      expect(cols).toEqual(expect.arrayContaining(["member", "status", "transcript_sid"]));
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
