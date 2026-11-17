import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// The dialler's routes on a real in-memory ledger, the Setup merge of
// `calls`, and the cadence routes on a call step. Nothing paid: a brief is
// either cached first or comes from a mocked preview.

let ledger: Ledger;
let cfg: Record<string, unknown> = {};
const previewMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, loadConfig: () => cfg, logEvent: () => {} };
});
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, previewCadenceStep: (input: unknown) => previewMock(input) };
});

const { listCallsRoute, callBriefRoute, logCallRoute, prospectCallsRoute } =
  await import("../src/api/calls.ts");
const { previewCadenceStepRoute, sendCadenceStepRoute } = await import("../src/api/cadences.ts");
const { mergeCalls, SetupValidationError } = await import("../src/api/setup.ts");

const BRIEF = {
  opener: "Hi Dana",
  offer: "We fix renewals.",
  questions: ["How?"],
  objections: [],
  voicemail: "Hi Dana, I'll email.",
  gatekeeper: null,
};

function post(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  cfg = { calls: { enabled: true }, cadenceOverrides: null, directMailMotions: {}, timezone: null };
  previewMock.mockReset();
});
afterEach(() => ledger.close());

describe("GET /api/calls", () => {
  it("answers enabled:false with empty lists when calls are off", async () => {
    cfg = {};
    const res = listCallsRoute(new Request("http://localhost/api/calls"));
    expect(await res.json()).toEqual({
      enabled: false,
      dialMode: "tel",
      window: { start: "09:00", end: "17:00", weekdays: true },
      due: [],
      list: [],
    });
  });

  it("lists people with a number", async () => {
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: "+15126531187" });
    const body = await listCallsRoute(new Request("http://localhost/api/calls")).json();
    expect(body.list.map((r: { prospectId: number }) => r.prospectId)).toEqual([id]);
  });
});

describe("POST /api/prospects/:id/call", () => {
  it("validates the body", async () => {
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    expect((await logCallRoute(post(`/x`, { outcome: "maybe" }), { id: String(id) })).status).toBe(
      400,
    );
    expect(
      (
        await logCallRoute(post(`/x`, { outcome: "no_answer", durationSec: -1 }), {
          id: String(id),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await logCallRoute(post(`/x`, { outcome: "not_now", holdUntil: "soon" }), {
          id: String(id),
        })
      ).status,
    ).toBe(400);
    expect((await logCallRoute(post(`/x`, { outcome: "no_answer" }), { id: "999" })).status).toBe(
      404,
    );
  });

  it("logs the call and lists it on the prospect, newest first", async () => {
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: "+15126531187" });
    const first = await logCallRoute(post(`/x`, { outcome: "no_answer" }), { id: String(id) });
    expect(first.status).toBe(200);
    expect((await first.json()).call).toMatchObject({ outcome: "no_answer", provider: "tel" });
    await logCallRoute(post(`/x`, { outcome: "voicemail", note: "left one", durationSec: 25 }), {
      id: String(id),
    });
    const list = await prospectCallsRoute(new Request("http://localhost/x"), {
      id: String(id),
    }).json();
    expect(list.calls.map((c: { outcome: string }) => c.outcome).toSorted()).toEqual([
      "no_answer",
      "voicemail",
    ]);
  });

  it("refuses to change a call logged do-not-contact (409) and checks the number dialled", async () => {
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test", phone: "+15126531187" });
    const params = { id: String(id) };
    expect(
      (await logCallRoute(post(`/x`, { outcome: "no_answer", phone: 15126531187 }), params)).status,
    ).toBe(400);
    const res = await logCallRoute(
      post(`/x`, { outcome: "do_not_contact", phone: "(512) 653-1187" }),
      params,
    );
    const { call } = await res.json();
    const change = await logCallRoute(
      post(`/x`, { outcome: "interested", callId: call.id }),
      params,
    );
    expect(change.status).toBe(409);
    expect(ledger.getCall(call.id)!.outcome).toBe("do_not_contact");
  });
});

describe("POST /api/calls/brief", () => {
  it("refuses while calls are off, needs a prospect, and returns the cached brief unpaid", async () => {
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    cfg = {};
    expect((await callBriefRoute(post("/api/calls/brief", { prospectId: id }))).status).toBe(409);
    cfg = { calls: { enabled: true } };
    expect((await callBriefRoute(post("/api/calls/brief", {}))).status).toBe(400);
    expect((await callBriefRoute(post("/api/calls/brief", { prospectId: 999 }))).status).toBe(404);
    ledger.saveCallBrief({ prospectId: id, playName: null, brief: BRIEF });
    const res = await callBriefRoute(post("/api/calls/brief", { prospectId: id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brief: BRIEF });
  });
});

describe("cadence routes on a call step", () => {
  it("the preview carries the brief", async () => {
    previewMock.mockResolvedValue({
      subject: "Call brief",
      body: "Opener: Hi Dana",
      flags: [],
      draftedAt: "now",
      stepLabel: "Call",
      isBreakup: false,
      payload: { kind: "call", toPhone: "+15126531187", brief: BRIEF },
    });
    const res = await previewCadenceStepRoute(post("/api/cadences/7/preview-next?play=p"), {
      id: "7",
    });
    expect(await res.json()).toMatchObject({ kind: "call", brief: BRIEF, toPhone: "+15126531187" });
  });

  it("send-next refuses a stored call brief with a 409", async () => {
    const id = ledger.upsertProspect({ name: "Dana", email: "d@a.test" });
    ledger.enrollCadence({ prospectId: id, playName: "p", nextDueAt: new Date().toISOString() });
    ledger.setCadenceDraft({
      prospectId: id,
      playName: "p",
      draft: {
        subject: "Call brief",
        body: "b",
        flags: [],
        payload: { kind: "call", toPhone: "", brief: BRIEF },
      },
    });
    const res = await sendCadenceStepRoute(post(`/api/cadences/${id}/send-next?play=p`), {
      id: String(id),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A call step is logged from the Calls page");
  });
});

describe("mergeCalls", () => {
  const bridge = {
    provider: "twilio" as const,
    founderPhone: "+15550001111",
    callerId: "+15550002222",
  };

  it("keeps the stored object, including a bridge, when untouched or partly changed", () => {
    const current = { enabled: false, bridge };
    expect(mergeCalls(undefined, current)).toBe(current);
    expect(
      mergeCalls(
        {
          enabled: true,
          cadenceStep: { position: 3, delayDays: 5, holdDays: 3 },
          window: { start: "09:30", end: "16:00", weekdays: true },
        },
        current,
      ),
    ).toEqual({
      enabled: true,
      bridge,
      cadenceStep: { position: 3, delayDays: 5, holdDays: 3 },
      window: { start: "09:30", end: "16:00", weekdays: true },
    });
    expect(mergeCalls({ cadenceStep: null }, { enabled: true })).toEqual({
      enabled: true,
      cadenceStep: null,
    });
  });

  it.each([
    [{ enabled: "yes" }],
    [{ cadenceStep: { position: 1, delayDays: 2 } }],
    [{ cadenceStep: { position: 3, delayDays: -1 } }],
    [{ cadenceStep: { position: 3, delayDays: 2, holdDays: 0 } }],
    [{ window: { start: "17:00", end: "09:00" } }],
    [{ window: { start: "9am", end: "5pm" } }],
  ])("refuses %j", (incoming) => {
    expect(() => mergeCalls(incoming as never, undefined)).toThrow(SetupValidationError);
  });
});
