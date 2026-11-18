import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";
import { getSharedDb } from "@oneshot-gtm/core";

// The bridged-call routes end to end over a stubbed global fetch: every
// Twilio request is answered here, none leaves the process.

let ledger: Ledger;
let cfg: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, loadConfig: () => cfg, logEvent: () => {} };
});

const routes = await import("../src/api/calls.ts");
const { settleBridgedCallWork } = await import("@oneshot-gtm/plays");

const ACCOUNT = "https://api.twilio.com/2010-04-01/Accounts/AC1";
const MEMBER = "+14155550111";
const PROSPECT = "+15126531187";

interface Sent {
  method: string;
  url: string;
  form: Record<string, string>;
}
let sent: Sent[] = [];
let answers: Record<string, () => { status?: number; body: unknown }> = {};

function req(path: string, init: { method?: string; body?: unknown; member?: boolean } = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    method: init.method ?? "GET",
    // No Host header: the request is nobody's.
    headers: {
      ...(init.member === false ? {} : { host: "127.0.0.1" }),
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function keys(on = true) {
  if (on) {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_API_KEY_SID", "SK1");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "secret");
  } else {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
  }
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  cfg = { calls: { enabled: true } };
  sent = [];
  answers = {};
  getSharedDb().deleteMemberPhone("");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      sent.push({
        method,
        url,
        form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
      });
      const key = Object.keys(answers)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .toSorted((a, b) => b.length - a.length)[0];
      const out = key
        ? answers[key]!()
        : { status: 500, body: { message: `no answer for ${url}` } };
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
    }),
  );
});
afterEach(async () => {
  await settleBridgedCallWork();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  ledger.close();
});

describe("bridged-call routes", () => {
  it("refuse a request that is nobody's", async () => {
    keys();
    const nobody = { member: false };
    const responses = [
      routes.callsMeRoute(req("/api/calls/me", nobody)),
      await routes.verifyPhoneRoute(
        req("/x", { ...nobody, method: "POST", body: { phone: MEMBER } }),
      ),
      await routes.checkPhoneRoute(req("/x", { ...nobody, method: "POST" })),
      await routes.removePhoneRoute(req("/x", { ...nobody, method: "DELETE" })),
      await routes.startCallRoute(
        req("/x", { ...nobody, method: "POST", body: { prospectId: 1 } }),
      ),
      await routes.getCallRoute(req("/x", nobody), { id: "1" }),
      await routes.hangUpCallRoute(req("/x", { ...nobody, method: "POST" }), { id: "1" }),
      await routes.recordCallRoute(req("/x", { ...nobody, method: "POST" }), { id: "1" }),
      await routes.discardRecordingRoute(req("/x", { ...nobody, method: "POST" }), { id: "1" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403]);
    expect(sent).toEqual([]);
  });

  it("report the bridge not ready, and refuse to verify or call, without the keys", async () => {
    keys(false);
    expect(await routes.callsMeRoute(req("/api/calls/me")).json()).toEqual({
      bridgeReady: false,
      record: "ask",
      phone: { phone: null, status: "none", validationCode: null, verifiedAt: null, error: null },
    });
    const verify = await routes.verifyPhoneRoute(
      req("/x", { method: "POST", body: { phone: MEMBER } }),
    );
    expect(verify.status).toBe(409);
    expect((await verify.json()).error).toMatch(/Twilio keys/);
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: PROSPECT });
    const start = await routes.startCallRoute(
      req("/x", { method: "POST", body: { prospectId: id } }),
    );
    expect(start.status).toBe(409);
    expect((await start.json()).error).toMatch(/Twilio keys/);
    expect(sent).toEqual([]);
  });

  it("verify the member's phone, ring it, dial the prospect, and record once they agree", async () => {
    keys();
    let listed = false;
    answers[`GET ${ACCOUNT}/OutgoingCallerIds.json?PhoneNumber=%2B14155550111`] = () => ({
      body: { outgoing_caller_ids: listed ? [{ sid: "PN1", phone_number: MEMBER }] : [] },
    });
    answers[`POST ${ACCOUNT}/OutgoingCallerIds.json`] = () => ({
      status: 201,
      body: { validation_code: "246810", phone_number: MEMBER },
    });
    expect((await routes.verifyPhoneRoute(req("/x", { method: "POST", body: {} }))).status).toBe(
      400,
    );
    const verifying = await routes.verifyPhoneRoute(
      req("/x", { method: "POST", body: { phone: "(415) 555-0111" } }),
    );
    expect(await verifying.json()).toMatchObject({
      phone: MEMBER,
      status: "verifying",
      validationCode: "246810",
    });
    expect(sent.find((s) => s.method === "POST")?.form).toMatchObject({ PhoneNumber: MEMBER });

    const list = () => routes.listCallsRoute(req("/api/calls")).json();
    expect((await list()).dialMode).toBe("tel");
    listed = true;
    expect(
      await (await routes.checkPhoneRoute(req("/x", { method: "POST" }))).json(),
    ).toMatchObject({ status: "verified" });
    expect((await list()).dialMode).toBe("bridge");

    const id = ledger.upsertProspect({
      name: "Dana Smith",
      email: "d@a.test",
      company: "R&D <Labs>",
      phone: PROSPECT,
    });
    // Any hour: the window is every day, all day.
    cfg = { calls: { enabled: true, window: { start: "00:00", end: "23:59", weekdays: false } } };
    answers[`POST ${ACCOUNT}/Calls.json`] = () => ({ status: 201, body: { sid: "CA1" } });
    const started = await routes.startCallRoute(
      req("/x", { method: "POST", body: { prospectId: id, playName: "renewals" } }),
    );
    expect(started.status).toBe(200);
    const call = await started.json();
    expect(call).toMatchObject({
      prospectId: id,
      playName: "renewals",
      member: null,
      provider: "twilio",
      status: "ringing_founder",
      transcriptStatus: "none",
    });
    const create = sent.find((s) => s.method === "POST" && s.url === `${ACCOUNT}/Calls.json`)!;
    // The member's leg alone, with machine detection: nobody else is dialled yet.
    expect(create.form).toEqual({
      To: MEMBER,
      From: MEMBER,
      MachineDetection: "Enable",
      Twiml: `<Response><Say>Calling Dana at R&amp;D &lt;Labs&gt;</Say><Pause length="40"/></Response>`,
    });

    // The dial panel's poll: a person answered, so the held call dials the prospect.
    answers[`GET ${ACCOUNT}/Calls/CA1.json`] = () => ({
      body: { sid: "CA1", status: "in-progress", answered_by: "human" },
    });
    answers[`GET ${ACCOUNT}/Calls.json?ParentCallSid=CA1`] = () => ({ body: { calls: [] } });
    answers[`POST ${ACCOUNT}/Calls/CA1.json`] = () => ({
      body: { sid: "CA1", status: "in-progress" },
    });
    const polled = await routes.getCallRoute(req(`/api/calls/${call.id}`), { id: String(call.id) });
    expect(await polled.json()).toMatchObject({ id: call.id, status: "ringing_prospect" });
    const updates = () =>
      sent.filter((s) => s.url === `${ACCOUNT}/Calls/CA1.json` && s.method === "POST");
    // Nothing is recorded before the prospect agrees.
    expect(updates().map((u) => u.form)).toEqual([
      {
        Twiml: `<Response><Dial callerId="${MEMBER}" answerOnBridge="true"><Number>${PROSPECT}</Number></Dial></Response>`,
      },
    ]);
    answers[`GET ${ACCOUNT}/Calls.json?ParentCallSid=CA1`] = () => ({
      body: { calls: [{ sid: "CA2", status: "ringing" }] },
    });
    await routes.getCallRoute(req(`/api/calls/${call.id}`), { id: String(call.id) });
    expect(updates()).toHaveLength(1);
    const record = () =>
      routes.recordCallRoute(req("/x", { method: "POST" }), { id: String(call.id) });
    expect((await record()).status).toBe(409);
    answers[`GET ${ACCOUNT}/Calls.json?ParentCallSid=CA1`] = () => ({
      body: {
        calls: [{ sid: "CA2", status: "in-progress", start_time: new Date().toUTCString() }],
      },
    });
    answers[`POST ${ACCOUNT}/Calls/CA1/Recordings.json`] = () => ({
      status: 201,
      body: { sid: "RE1", status: "in-progress" },
    });
    const recording = await record();
    expect(await recording.json()).toMatchObject({ transcriptStatus: "pending" });
    expect(sent.filter((s) => s.url.endsWith("/Recordings.json"))).toEqual([
      expect.objectContaining({ method: "POST", form: { RecordingChannels: "dual" } }),
    ]);

    const hung = await routes.hangUpCallRoute(req("/x", { method: "POST" }), {
      id: String(call.id),
    });
    expect(hung.status).toBe(200);
    expect(updates().at(-1)?.form).toEqual({ Status: "completed" });

    // Removing the phone removes it from Twilio too.
    answers[`DELETE ${ACCOUNT}/OutgoingCallerIds/PN1.json`] = () => ({ status: 204, body: null });
    expect(
      await (await routes.removePhoneRoute(req("/x", { method: "DELETE" }))).json(),
    ).toMatchObject({ status: "none", phone: null });
    expect(sent.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${ACCOUNT}/OutgoingCallerIds/PN1.json`,
    });
    expect((await list()).dialMode).toBe("tel");
  });

  it("answer the provider's refusal as 502 and a bad id as 400", async () => {
    keys();
    getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "verified" });
    cfg = { calls: { enabled: true, window: { start: "00:00", end: "23:59", weekdays: false } } };
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: PROSPECT });
    answers[`POST ${ACCOUNT}/Calls.json`] = () => ({
      status: 400,
      body: { code: 21210, message: "The source phone number provided is not yet verified." },
    });
    const res = await routes.startCallRoute(
      req("/x", { method: "POST", body: { prospectId: id } }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "Twilio: The source phone number provided is not yet verified.",
    );
    expect(ledger.listCallsForProspect(id)).toEqual([]);
    expect((await routes.getCallRoute(req("/x"), { id: "me" })).status).toBe(400);
    expect((await routes.getCallRoute(req("/x"), { id: "999" })).status).toBe(404);
    expect(
      (await routes.startCallRoute(req("/x", { method: "POST", body: { prospectId: "x" } })))
        .status,
    ).toBe(400);
  });

  it("log a bridged call's confirmed promises, and delete its recording on its own", async () => {
    keys();
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: PROSPECT });
    const callId = ledger.insertCall({
      prospectId: id,
      startedAt: new Date().toISOString(),
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
      transcriptStatus: "pending",
    });
    ledger.claimBridge(callId, new Date().toISOString());
    ledger.updateBridgedCall(callId, { recordingSid: "RE1" });
    const log = (body: Record<string, unknown>) =>
      routes.logCallRoute(req("/x", { method: "POST", body: { outcome: "interested", ...body } }), {
        id: String(id),
      });
    expect((await log({ callId, commitments: "send terms" })).status).toBe(400);
    expect((await log({ callId, commitments: ["x".repeat(301)] })).status).toBe(400);
    const kept = await (await log({ callId, commitments: [" send terms ", ""] })).json();
    expect(kept.call.commitments).toEqual(["send terms"]);

    answers[`GET ${ACCOUNT}/Calls/CA1.json`] = () => ({
      body: { sid: "CA1", status: "completed" },
    });
    answers["GET https://intelligence.twilio.com/v2/Transcripts?SourceSid=RE1"] = () => ({
      body: { transcripts: [{ sid: "GT1" }] },
    });
    answers["DELETE https://intelligence.twilio.com/v2/Transcripts/GT1"] = () => ({
      status: 204,
      body: null,
    });
    answers[`DELETE ${ACCOUNT}/Recordings/RE1.json`] = () => ({ status: 204, body: null });
    const discard = (callIdText: string) =>
      routes.discardRecordingRoute(req("/x", { method: "POST" }), { id: callIdText });
    expect((await discard("x")).status).toBe(400);
    expect((await discard("999")).status).toBe(404);
    const declined = await discard(String(callId));
    expect(declined.status).toBe(200);
    const out = await declined.json();
    expect(out).toMatchObject({
      outcome: "interested",
      transcriptStatus: "none",
      transcript: null,
    });
    expect(out).not.toHaveProperty("commitments");
    expect(sent.filter((s) => s.method === "DELETE").map((s) => s.url)).toEqual([
      "https://intelligence.twilio.com/v2/Transcripts/GT1",
      `${ACCOUNT}/Recordings/RE1.json`,
    ]);
  });

  it("acknowledge a declined recording once it is stored, even when Twilio is down", async () => {
    keys();
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: PROSPECT });
    const callId = ledger.insertCall({
      prospectId: id,
      startedAt: new Date().toISOString(),
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
      transcriptStatus: "pending",
    });
    ledger.updateBridgedCall(callId, { recordingSid: "RE1" });
    const res = await routes.discardRecordingRoute(req("/x", { method: "POST" }), {
      id: String(callId),
    });
    expect(res.status).toBe(200);
    expect(ledger.getBridgedCall(callId)?.discardPending).toBe(true);
  });

  it("log a tel: call with the member who logged it", async () => {
    getSharedDb().addMember({ email: "owner@example.com", role: "owner" });
    try {
      const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: PROSPECT });
      const res = await routes.logCallRoute(
        req("/x", { method: "POST", body: { outcome: "no_answer" } }),
        { id: String(id) },
      );
      expect((await res.json()).call).toMatchObject({
        member: "owner@example.com",
        provider: "tel",
      });
    } finally {
      getSharedDb().removeMember("owner@example.com");
    }
  });
});
