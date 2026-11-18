import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";
import {
  CallBridgeError,
  getSharedDb,
  type BridgeCallState,
  type BridgeRecording,
  type BridgeTranscript,
  type CallBridge,
} from "@oneshot-gtm/core";

// Bridged calls on a real in-memory ledger with a fake CallBridge (no
// provider request at all; the Twilio wire format is covered in core's
// call-bridge.test.ts) and the model mocked.

let ledger: Ledger;
let cfg: Record<string, unknown> = {};
const responses: string[] = [];
const prompts: string[] = [];
const timeouts: Array<number | undefined> = [];
const events: Array<[string, Record<string, unknown>]> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => cfg,
    logEvent: (name: string, fields: Record<string, unknown> = {}) => {
      events.push([name, fields]);
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => `prompt:${name}`,
    complete: async (input: {
      messages: Array<{ role: string; content: string }>;
      timeoutMs?: number;
    }) => {
      prompts.push(input.messages.map((m) => m.content).join("\n"));
      timeouts.push(input.timeoutMs);
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      return { content: next, provider: "t", model: "t" };
    },
  };
});

const bridgeMod = await import("../src/_call-bridge.ts");
const {
  startBridgedCall,
  refreshBridgedCall,
  hangUpBridgedCall,
  sweepBridgedCalls,
  parseCallOutcome,
  transcriptText,
  verifyMemberPhone,
  checkMemberPhone,
  removeMemberPhone,
  callsMe,
  memberCanBridge,
  settleBridgedCallWork,
  discardBridgedRecording,
  startBridgedRecording,
  assertCallActor,
  VERIFY_TIMEOUT_MS,
} = bridgeMod;
const { recordCall } = await import("../src/_calls.ts");
const { buildPriorCallsBlock } = await import("../src/_cadence.ts");

const MEMBER = "+14155550111";
const PROSPECT = "+15126531187"; // Austin: America/Chicago
/** Wednesday 10:00 in Chicago. */
const IN_WINDOW = new Date("2026-11-18T16:00:00Z");

interface Fake extends CallBridge {
  state: BridgeCallState;
  rec: BridgeRecording | null;
  tx: BridgeTranscript;
  verified: Set<string>;
}

function st(
  status: BridgeCallState["status"],
  durationSec: number | null,
  answered: boolean,
  answeredBy: string | null = "human",
): BridgeCallState {
  return { status, durationSec, answered, answeredBy };
}

/** Past the hold: the prospect was dialled. */
function bridged(id: number): number {
  ledger.claimBridge(id, IN_WINDOW.toISOString());
  return id;
}

function fakeBridge(over: Partial<CallBridge> = {}): Fake {
  const fake: Fake = {
    accountSid: "AC1",
    state: st("ringing_founder", null, false, null),
    rec: null,
    tx: { status: "pending" },
    verified: new Set(),
    verifyCallerId: vi.fn(async () => ({ validationCode: "654321" })),
    isVerified: vi.fn(async (phone: string) => fake.verified.has(phone)),
    start: vi.fn(async () => ({ callSid: "CA1" })),
    connect: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {}),
    removeCallerId: vi.fn(async (phone: string) => {
      fake.verified.delete(phone);
    }),
    deleteRecording: vi.fn(async () => {}),
    transcriptsFor: vi.fn(async () => ["GT1"]),
    deleteTranscript: vi.fn(async () => {}),
    status: vi.fn(async () => fake.state),
    hangUp: vi.fn(async () => {}),
    recording: vi.fn(async () => fake.rec),
    ensureService: vi.fn(async () => "GAnew"),
    transcribe: vi.fn(async () => ({ transcriptSid: "GT1" })),
    transcript: vi.fn(async () => fake.tx),
    ...over,
  };
  return fake;
}

function verifyOwner(phone = MEMBER) {
  getSharedDb().setMemberPhone({ member: "", phone, status: "verified", verifiedAt: "t" });
}

function prospect(extra: Record<string, unknown> = {}): number {
  return ledger.upsertProspect({
    name: "Dana Smith",
    email: "dana@acme.test",
    company: "Acme",
    phone: PROSPECT,
    ...extra,
  });
}

const LINES = [
  { speaker: "founder" as const, text: "Hi Dana, Sam here.", startSec: 0.5 },
  { speaker: "prospect" as const, text: "Send me the details by Friday.", startSec: 3 },
];

beforeEach(() => {
  ledger = new Ledger(":memory:");
  cfg = {
    calls: {
      enabled: true,
      bridge: { provider: "twilio", record: "always", transcriptionServiceSid: "GAcfg" },
    },
  };
  responses.length = 0;
  prompts.length = 0;
  timeouts.length = 0;
  events.length = 0;
  getSharedDb().deleteMemberPhone("");
  getSharedDb().deleteMemberPhone("mia@example.com");
});
afterEach(async () => {
  await settleBridgedCallWork();
  ledger.close();
});

describe("startBridgedCall", () => {
  it("refuses with a plain 409 and writes nothing when the call may not be placed", async () => {
    const id = prospect();
    const bridge = fakeBridge();
    const start = (over: Record<string, unknown> = {}) =>
      startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge, ...over }).then(
        () => null,
        (e: { status: number; message: string }) => [e.status, e.message] as const,
      );

    cfg = { calls: { enabled: false } };
    expect(await start()).toEqual([409, "calls are off for this workspace"]);
    cfg = { calls: { enabled: true, bridge: null } };
    expect(await start()).toEqual([409, "bridged calls are off for this workspace"]);
    cfg = { calls: { enabled: true } };
    expect((await start({ bridge: null }))?.[1]).toMatch(/Twilio keys/);
    expect((await start())?.[1]).toMatch(/verify your phone/);
    getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "verifying" });
    expect((await start())?.[1]).toMatch(/verify your phone/);
    verifyOwner();
    expect(await start({ prospectId: 999 })).toEqual([404, "prospect not found"]);
    expect(await start({ now: new Date("2026-11-18T09:00:00Z") })).toEqual([
      409,
      expect.stringMatching(/outside their call hours: it is 03:00 there; calls open .*09:00/),
    ]);
    cfg = { calls: { enabled: true }, doNotContact: { domains: ["acme.test"] } };
    expect(await start()).toEqual([409, "contact with this person is not allowed"]);
    cfg = { calls: { enabled: true } };
    const noNumber = prospect({ email: "nonum@else.test", phone: null, name: "No Number" });
    expect(await start({ prospectId: noNumber })).toEqual([
      409,
      "no usable number for this person",
    ]);
    const self = prospect({ email: "self@else.test", phone: MEMBER, name: "Self" });
    expect(await start({ prospectId: self })).toEqual([409, "that is your own number"]);
    recordCall(id, { outcome: "do_not_contact" });
    expect(await start()).toEqual([409, "contact with this person is not allowed"]);

    expect(bridge.start).not.toHaveBeenCalled();
    expect(ledger.listCallsForProspect(id).filter((c) => c.provider === "twilio")).toEqual([]);
  });

  it("rings the member, dials the prospect and writes the call with its member", async () => {
    getSharedDb().setMemberPhone({ member: "mia@example.com", phone: MEMBER, status: "verified" });
    const id = prospect();
    const bridge = fakeBridge();
    const call = await startBridgedCall({
      prospectId: id,
      playName: "renewals",
      member: "mia@example.com",
      now: IN_WINDOW,
      bridge,
    });
    expect(bridge.start).toHaveBeenCalledWith({ memberPhone: MEMBER, sayName: "Dana at Acme" });
    expect(call).toMatchObject({
      prospectId: id,
      playName: "renewals",
      member: "mia@example.com",
      provider: "twilio",
      status: "ringing_founder",
      transcriptStatus: "pending",
      outcome: null,
    });
    expect(ledger.getBridgedCall(call.id)).toMatchObject({
      callSid: "CA1",
      phone: PROSPECT,
      memberPhone: MEMBER,
      bridgedAt: null,
    });
  });

  it("does not record when record is off, and writes nothing when the provider refuses", async () => {
    verifyOwner();
    const id = prospect();
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: false } } };
    const bridge = fakeBridge();
    const call = await startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge });
    expect(call.transcriptStatus).toBe("none");
    bridge.state = st("ringing_prospect", null, false);
    await refreshBridgedCall(call.id, { bridge, now: IN_WINDOW });
    expect(vi.mocked(bridge.connect).mock.calls[0]![1].record).toBe(false);

    const refusing = fakeBridge({
      start: async () => {
        throw new CallBridgeError("Twilio: The number is unverified", 400, 21210);
      },
    });
    await expect(
      startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge: refusing }),
    ).rejects.toMatchObject({ status: 502, message: "Twilio: The number is unverified" });
    expect(ledger.listCallsForProspect(id)).toHaveLength(1);
  });
});

describe("the hold before the prospect is dialled", () => {
  async function held(bridge: Fake): Promise<number> {
    verifyOwner();
    return (
      await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })
    ).id;
  }

  it("waits while detection runs, then dials once for a person, even with two polls at once", async () => {
    const bridge = fakeBridge();
    const id = await held(bridge);
    bridge.state = st("ringing_prospect", null, false, null);
    expect((await refreshBridgedCall(id, { bridge, now: IN_WINDOW })).status).toBe(
      "ringing_founder",
    );
    expect(bridge.connect).not.toHaveBeenCalled();
    bridge.state = st("ringing_prospect", null, false, "human");
    const [a, b] = await Promise.all([
      refreshBridgedCall(id, { bridge, now: IN_WINDOW }),
      refreshBridgedCall(id, { bridge, now: IN_WINDOW }),
    ]);
    expect([a.status, b.status]).toEqual(["ringing_prospect", "ringing_prospect"]);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(bridge.connect).toHaveBeenCalledWith("CA1", {
      memberPhone: MEMBER,
      prospectPhone: PROSPECT,
      record: true,
    });
    bridge.state = st("connected", 5, true);
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(ledger.getCall(id)?.status).toBe("connected");
  });

  it("leaves a call another poll claimed as that poll wrote it", async () => {
    const bridge = fakeBridge();
    const id = await held(bridge);
    bridge.state = st("ringing_prospect", null, false, "human");
    vi.spyOn(ledger, "claimBridge").mockImplementationOnce(() => {
      ledger.updateBridgedCall(id, { status: "ended" });
      return false;
    });
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    expect(ledger.getCall(id)?.status).toBe("ended");
    expect(bridge.connect).not.toHaveBeenCalled();
  });

  it("checks the opt-outs and their hours again before dialling them", async () => {
    const bridge = fakeBridge();
    const id = await held(bridge);
    recordCall(ledger.getCall(id)!.prospectId, { outcome: "do_not_contact" });
    bridge.state = st("ringing_prospect", null, false, "human");
    expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW })).toMatchObject({
      status: "failed",
      statusReason: "contact with them is no longer allowed, so nobody was dialled",
    });
    const other = await startBridgedCall({
      prospectId: prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" }),
      member: null,
      now: IN_WINDOW,
      bridge,
    });
    // 17:30 in Chicago: the window closed while the member's phone rang.
    const closed = new Date("2026-11-18T23:30:00Z");
    expect(await refreshBridgedCall(other.id, { bridge, now: closed })).toMatchObject({
      status: "failed",
      statusReason: "their call hours closed while your phone rang, so nobody was dialled",
    });
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(bridge.hangUp).toHaveBeenCalledTimes(2);
  });

  it("dials on an undecided detection too", async () => {
    const bridge = fakeBridge();
    const id = await held(bridge);
    bridge.state = st("ringing_prospect", null, false, "unknown");
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    expect(bridge.connect).toHaveBeenCalledTimes(1);
  });

  it("hangs up a voicemail or fax without dialling anyone", async () => {
    for (const machine of ["machine_start", "fax"]) {
      const bridge = fakeBridge();
      const id = await held(bridge);
      bridge.state = st("ringing_prospect", null, false, machine);
      expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true })).toMatchObject({
        status: "failed",
        statusReason: "it went to your voicemail, so nobody was dialled",
        transcriptStatus: "none",
      });
      expect(bridge.connect).not.toHaveBeenCalled();
      expect(bridge.hangUp).toHaveBeenCalledWith("CA1");
      ledger.close();
      ledger = new Ledger(":memory:");
    }
  });

  it("says so when the hold ran out with nobody dialled, or the member never answered", async () => {
    const bridge = fakeBridge();
    const id = await held(bridge);
    bridge.state = st("ended", null, false, "human");
    expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true })).toMatchObject({
      status: "ended",
      statusReason: "the call ended before they were dialled",
      transcriptStatus: "none",
    });
    const other = await startBridgedCall({
      prospectId: prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" }),
      member: null,
      now: IN_WINDOW,
      bridge,
    });
    bridge.state = st("failed", null, false, null);
    expect((await refreshBridgedCall(other.id, { bridge, now: IN_WINDOW })).statusReason).toBe(
      "your phone did not answer",
    );
    expect(bridge.connect).not.toHaveBeenCalled();
  });

  it("fails the call when dialling is refused, and waits when its outcome is unknown", async () => {
    const refusing = fakeBridge({
      connect: async () => {
        throw new CallBridgeError("Twilio: Call is not in-progress", 400);
      },
    });
    const id = await held(refusing);
    refusing.state = st("ringing_prospect", null, false, "human");
    expect(await refreshBridgedCall(id, { bridge: refusing, now: IN_WINDOW })).toMatchObject({
      status: "failed",
      statusReason: "could not dial them: Twilio: Call is not in-progress",
    });
    expect(refusing.hangUp).toHaveBeenCalled();

    const unsure = fakeBridge({
      connect: async () => {
        throw new CallBridgeError("timed out", 0, null, true);
      },
    });
    const other = await startBridgedCall({
      prospectId: prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" }),
      member: null,
      now: IN_WINDOW,
      bridge: unsure,
    });
    unsure.state = st("ringing_prospect", null, false, "human");
    expect((await refreshBridgedCall(other.id, { bridge: unsure, now: IN_WINDOW })).status).toBe(
      "ringing_prospect",
    );
    expect(unsure.hangUp).not.toHaveBeenCalled();
  });
});

describe("a start whose outcome is unclear", () => {
  it("records a timed-out start as failed with a plain message and never retries it", async () => {
    verifyOwner();
    const id = prospect();
    const bridge = fakeBridge({
      start: vi.fn(async () => {
        throw new CallBridgeError("timed out", 0, null, true);
      }),
    });
    await expect(
      startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge }),
    ).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/may still ring/) });
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(ledger.listCallsForProspect(id)).toEqual([
      expect.objectContaining({
        provider: "twilio",
        status: "failed",
        statusReason: expect.stringMatching(/check it before calling again/),
      }),
    ]);
  });

  it("hangs up a call it could not write down, and logs its SID when that fails too", async () => {
    verifyOwner();
    const id = prospect();
    const bridge = fakeBridge();
    const spy = vi.spyOn(ledger, "insertCall").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(
      startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge }),
    ).rejects.toThrow("database is locked");
    expect(bridge.hangUp).toHaveBeenCalledWith("CA1");
    expect(events.find(([n]) => n === "call.untracked")).toBeUndefined();

    vi.mocked(bridge.hangUp).mockRejectedValueOnce(new Error("down"));
    spy.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(
      startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge }),
    ).rejects.toThrow("database is locked");
    expect(events.find(([n]) => n === "call.untracked")?.[1]).toMatchObject({ call_sid: "CA1" });
  });
});

describe("a prospect who declined recording", () => {
  async function recorded(bridge: Fake): Promise<number> {
    verifyOwner();
    const id = bridged(
      (await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })).id,
    );
    bridge.state = st("ended", 61, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 61 };
    bridge.tx = { status: "ready", lines: LINES };
    responses.push(JSON.stringify({ outcome: "interested", note: "n", commitments: [] }));
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("ready");
    return id;
  }

  it("deletes the provider's transcripts and recording and keeps none of it", async () => {
    const bridge = fakeBridge();
    const id = await recorded(bridge);
    const prospectId = ledger.getCall(id)!.prospectId;
    // Logged first with a promise from the transcript: the deletion drops it too.
    recordCall(prospectId, { outcome: "not_interested", callId: id, commitments: ["send it"] });
    const out = await discardBridgedRecording(id, { bridge, now: IN_WINDOW });
    expect(out).toMatchObject({
      outcome: "not_interested",
      transcriptStatus: "none",
      transcript: null,
      suggestion: null,
    });
    expect(out).not.toHaveProperty("commitments");
    expect(bridge.transcriptsFor).toHaveBeenCalledWith("RE1");
    expect(bridge.deleteTranscript).toHaveBeenCalledWith("GT1");
    expect(bridge.deleteRecording).toHaveBeenCalledWith("RE1");
    expect(ledger.getBridgedCall(id)).toMatchObject({
      discardPending: false,
      recordingSid: null,
      transcriptSid: null,
    });
    // Nothing is transcribed again.
    expect(await sweepBridgedCalls({ bridge, now: IN_WINDOW })).toEqual({ checked: 0, gaveUp: 0 });
  });

  it("hangs up a live call and deletes the recording once it is processed", async () => {
    verifyOwner();
    const bridge = fakeBridge();
    const id = bridged(
      (await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })).id,
    );
    bridge.state = st("connected", 5, true);
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    vi.mocked(bridge.hangUp).mockImplementationOnce(async () => {
      bridge.state = st("ended", 8, true);
    });
    bridge.rec = { sid: "RE1", status: "processing", durationSec: null };
    await discardBridgedRecording(id, { bridge, now: IN_WINDOW });
    expect(bridge.hangUp).toHaveBeenCalledWith("CA1");
    expect(bridge.deleteRecording).not.toHaveBeenCalled();
    expect(ledger.getBridgedCall(id)?.discardPending).toBe(true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 8 };
    expect((await sweepBridgedCalls({ bridge, now: IN_WINDOW })).checked).toBe(1);
    expect(bridge.deleteRecording).toHaveBeenCalledWith("RE1");
    expect(bridge.transcribe).not.toHaveBeenCalled();
    expect(ledger.getBridgedCall(id)?.discardPending).toBe(false);
  });

  it("needs no outcome, and retries a hang-up that failed while the call is live", async () => {
    verifyOwner();
    const bridge = fakeBridge();
    const id = bridged(
      (await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })).id,
    );
    bridge.state = st("connected", 5, true);
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    vi.mocked(bridge.hangUp).mockRejectedValue(new CallBridgeError("Twilio: down", 503));
    const out = await discardBridgedRecording(id, { bridge, now: IN_WINDOW });
    expect(out.outcome).toBeNull();
    expect(ledger.getBridgedCall(id)?.discardPending).toBe(true);
    const tries = vi.mocked(bridge.hangUp).mock.calls.length;
    expect(tries).toBeGreaterThanOrEqual(2);
    vi.mocked(bridge.hangUp).mockReset();
    vi.mocked(bridge.hangUp).mockImplementation(async () => {
      bridge.state = st("ended", 9, true);
    });
    await sweepBridgedCalls({ bridge, now: IN_WINDOW });
    expect(bridge.hangUp).toHaveBeenCalledWith("CA1");
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 9 };
    await sweepBridgedCalls({ bridge, now: IN_WINDOW });
    expect(bridge.deleteRecording).toHaveBeenCalledWith("RE1");
    expect(bridge.transcribe).not.toHaveBeenCalled();
  });

  it("never asks for a transcript once declined while the service was looked up", async () => {
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "always" } } };
    getSharedDb().setInstallSetting("calls.transcriptionServiceSid", "null");
    verifyOwner();
    let id = 0;
    const bridge = fakeBridge({
      ensureService: vi.fn(async () => {
        ledger.markRecordingDiscard(id);
        return "GAnew";
      }),
    });
    id = bridged(
      (await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })).id,
    );
    bridge.state = st("ended", 30, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 30 };
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true });
    expect(bridge.ensureService).toHaveBeenCalled();
    expect(bridge.transcribe).not.toHaveBeenCalled();
  });

  it("is still deleted after the sweep's lookback has passed", async () => {
    const bridge = fakeBridge();
    const id = ledger.insertCall({
      prospectId: prospect(),
      startedAt: new Date(IN_WINDOW.getTime() - 5 * 24 * 3600_000).toISOString(),
      provider: "twilio",
      providerCallSid: "CAold",
      status: "ended",
      transcriptStatus: "pending",
    });
    ledger.updateBridgedCall(id, { recordingSid: "REold" });
    ledger.markRecordingDiscard(id);
    expect((await sweepBridgedCalls({ bridge, now: IN_WINDOW })).checked).toBe(1);
    expect(bridge.deleteRecording).toHaveBeenCalledWith("REold");
    expect(ledger.getBridgedCall(id)?.discardPending).toBe(false);
  });
});

describe("recording only once the prospect agreed (ask)", () => {
  beforeEach(() => {
    cfg = {
      calls: {
        enabled: true,
        bridge: { provider: "twilio", record: "ask", transcriptionServiceSid: "GAcfg" },
      },
    };
    verifyOwner();
  });

  async function connected(bridge: Fake): Promise<number> {
    const call = await startBridgedCall({
      prospectId: prospect(),
      member: null,
      now: IN_WINDOW,
      bridge,
    });
    expect(call.transcriptStatus).toBe("none");
    bridge.state = st("ringing_prospect", null, false, "human");
    await refreshBridgedCall(call.id, { bridge, now: IN_WINDOW });
    expect(vi.mocked(bridge.connect).mock.calls[0]![1].record).toBe(false);
    return call.id;
  }

  it("dials without recording, then records once from Record, and transcribes that", async () => {
    const bridge = fakeBridge();
    const id = await connected(bridge);
    await expect(startBridgedRecording(id, { bridge })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/only while you are connected/),
    });
    bridge.state = st("connected", 5, true);
    const [a, b] = await Promise.all([
      startBridgedRecording(id, { bridge }),
      startBridgedRecording(id, { bridge }),
    ]);
    expect([a.transcriptStatus, b.transcriptStatus]).toEqual(["pending", "pending"]);
    expect(bridge.startRecording).toHaveBeenCalledTimes(1);
    expect(bridge.startRecording).toHaveBeenCalledWith("CA1");

    bridge.state = st("ended", 40, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 30 };
    bridge.tx = { status: "ready", lines: LINES };
    responses.push(JSON.stringify({ outcome: "interested", note: "n", commitments: [] }));
    expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true })).toMatchObject({
      transcriptStatus: "ready",
      transcript: LINES,
    });
    expect(timeouts).toEqual([60_000]);
  });

  it("keeps a call nobody recorded at no transcript", async () => {
    const bridge = fakeBridge();
    const id = await connected(bridge);
    bridge.state = st("ended", 40, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 30 };
    expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true })).toMatchObject({
      transcriptStatus: "none",
    });
    expect(bridge.recording).not.toHaveBeenCalled();
  });

  it("goes back to unrecorded when Twilio refuses, stays pending when it is unsure", async () => {
    const bridge = fakeBridge();
    const id = await connected(bridge);
    bridge.state = st("connected", 5, true);
    vi.mocked(bridge.startRecording).mockRejectedValueOnce(
      new CallBridgeError("Twilio: Call is not in-progress", 400, 21220),
    );
    await expect(startBridgedRecording(id, { bridge })).rejects.toMatchObject({ status: 502 });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("none");
    vi.mocked(bridge.startRecording).mockRejectedValueOnce(
      new CallBridgeError("timed out", 0, null, true),
    );
    await expect(startBridgedRecording(id, { bridge })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/may be recording/),
    });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("pending");
  });

  it("refuses with recording off, and for a call that is not bridged", async () => {
    const bridge = fakeBridge();
    const id = await connected(bridge);
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: false } } };
    await expect(startBridgedRecording(id, { bridge })).rejects.toMatchObject({ status: 409 });
    await expect(startBridgedRecording(9999, { bridge })).rejects.toMatchObject({ status: 404 });
    expect(bridge.startRecording).not.toHaveBeenCalled();
  });
});

describe("following a bridged call", () => {
  async function placed(bridge: Fake): Promise<number> {
    verifyOwner();
    const id = prospect();
    return bridged(
      (await startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge })).id,
    );
  }

  it("stores the live state, then advances recording, transcript and suggestion", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    const later = new Date(IN_WINDOW.getTime() + 60_000);
    bridge.state = st("connected", 12, true);
    expect(await refreshBridgedCall(id, { bridge, now: later, wait: true })).toMatchObject({
      status: "connected",
      durationSec: 12,
      transcriptStatus: "pending",
    });
    expect(bridge.recording).not.toHaveBeenCalled();

    bridge.state = st("ended", 61, true);
    bridge.rec = { sid: "RE1", status: "processing", durationSec: null };
    expect(await refreshBridgedCall(id, { bridge, now: later, wait: true })).toMatchObject({
      status: "ended",
      durationSec: 61,
      transcriptStatus: "pending",
    });
    expect(bridge.transcribe).not.toHaveBeenCalled();

    bridge.rec = { sid: "RE1", status: "completed", durationSec: 61 };
    await refreshBridgedCall(id, { bridge, now: later, wait: true });
    // The configured service: none is created.
    expect(bridge.transcribe).toHaveBeenCalledWith({ recordingSid: "RE1", serviceSid: "GAcfg" });
    expect(bridge.ensureService).not.toHaveBeenCalled();
    expect(ledger.getBridgedCall(id)).toMatchObject({ recordingSid: "RE1", transcriptSid: "GT1" });

    bridge.tx = { status: "ready", lines: LINES };
    responses.push(
      JSON.stringify({
        outcome: "interested",
        note: "Wants details.",
        commitments: ["send details by Friday"],
      }),
    );
    const done = await refreshBridgedCall(id, { bridge, now: later, wait: true });
    expect(done).toMatchObject({
      transcriptStatus: "ready",
      transcript: LINES,
      suggestion: {
        outcome: "interested",
        note: "Wants details.",
        commitments: ["send details by Friday"],
      },
      outcome: null,
    });
    expect(prompts[0]).toContain("prompt:call-outcome");
    expect(prompts[0]).toContain("[0:03] PROSPECT: Send me the details by Friday.");
    expect(bridge.status).toHaveBeenCalledTimes(2);

    // Nothing left to do: a later read asks the provider nothing.
    await refreshBridgedCall(id, { bridge, now: later, wait: true });
    expect(bridge.status).toHaveBeenCalledTimes(2);
    expect(bridge.transcript).toHaveBeenCalledTimes(2);

    // The member confirms it: the bridged call keeps its own number and member.
    const logged = recordCall(done.prospectId, { outcome: "interested", callId: id }, later, "x@y");
    expect(logged).toMatchObject({ id, outcome: "interested", member: null, provider: "twilio" });
  });

  it("replaces a kept transcription service Twilio no longer has", async () => {
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "always" } } };
    getSharedDb().setInstallSetting(
      "calls.transcriptionServiceSid",
      JSON.stringify({ accountSid: "AC1", sid: "GAgone" }),
    );
    const bridge = fakeBridge({
      transcribe: vi.fn(async ({ serviceSid }: { serviceSid: string }) => {
        if (serviceSid === "GAgone") throw new CallBridgeError("Twilio: not found", 404, 20404);
        return { transcriptSid: "GT1" };
      }),
    });
    const id = await placed(bridge);
    bridge.state = st("ended", 30, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 30 };
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true });
    expect(bridge.ensureService).toHaveBeenCalledTimes(1);
    expect(bridge.transcribe).toHaveBeenLastCalledWith({
      recordingSid: "RE1",
      serviceSid: "GAnew",
    });
    expect(ledger.getBridgedCall(id)?.transcriptSid).toBe("GT1");
    expect(getSharedDb().installSetting("calls.transcriptionServiceSid")).toContain("GAnew");
  });

  it("returns at once without wait, the work finishing in the background", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    bridge.state = st("ended", 30, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 30 };
    bridge.tx = { status: "ready", lines: LINES };
    responses.push("not json");
    const first = await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    expect(first.status).toBe("ended");
    await settleBridgedCallWork();
    expect(ledger.getCall(id)).toMatchObject({
      transcriptStatus: "ready",
      suggestion: { outcome: "not_now", note: "", commitments: [] },
    });
  });

  it("records nothing when the prospect never answered, and marks a failed transcript", async () => {
    const bridge = fakeBridge();
    const unanswered = await placed(bridge);
    bridge.state = st("ended", null, false);
    expect(
      await refreshBridgedCall(unanswered, { bridge, now: IN_WINDOW, wait: true }),
    ).toMatchObject({ status: "ended", transcriptStatus: "none" });
    expect(bridge.recording).not.toHaveBeenCalled();

    const other = prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" });
    const id = bridged(
      (await startBridgedCall({ prospectId: other, member: null, now: IN_WINDOW, bridge })).id,
    );
    bridge.state = st("ended", 40, true);
    bridge.rec = { sid: "RE2", status: "completed", durationSec: 40 };
    bridge.tx = { status: "failed" };
    expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true })).toMatchObject({
      transcriptStatus: "failed",
    });
  });

  it("gives up on a recording that never appears, and on one too short to transcribe", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    bridge.state = st("ended", 20, true);
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("pending");
    await refreshBridgedCall(id, {
      bridge,
      now: new Date(IN_WINDOW.getTime() + 20 * 60_000),
      wait: true,
    });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("none");

    const other = prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" });
    const short = bridged(
      (await startBridgedCall({ prospectId: other, member: null, now: IN_WINDOW, bridge })).id,
    );
    bridge.rec = { sid: "RE3", status: "completed", durationSec: 1 };
    await refreshBridgedCall(short, { bridge, now: IN_WINDOW, wait: true });
    expect(ledger.getCall(short)?.transcriptStatus).toBe("none");
    expect(bridge.transcribe).not.toHaveBeenCalled();
  });

  it("marks a call the provider no longer has failed, and hangs up through the bridge", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    await hangUpBridgedCall(id, { bridge });
    expect(bridge.hangUp).toHaveBeenCalledWith("CA1");
    vi.mocked(bridge.status).mockRejectedValueOnce(new CallBridgeError("Twilio: not found", 404));
    expect((await refreshBridgedCall(id, { bridge, wait: true })).status).toBe("failed");
    await expect(hangUpBridgedCall(12345, { bridge })).rejects.toMatchObject({ status: 404 });
    // A tel: call is returned as stored.
    const tel = recordCall(ledger.getCall(id)!.prospectId, { outcome: "no_answer" });
    expect(await refreshBridgedCall(tel.id, { bridge })).toEqual(tel);
  });
});

describe("sweepBridgedCalls", () => {
  it("finishes a call whose tab closed and gives up on a stale transcript", async () => {
    verifyOwner();
    const bridge = fakeBridge();
    const orphan = bridged(
      (await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })).id,
    );
    const stale = ledger.insertCall({
      prospectId: prospect({ email: "old@acme.test", name: "Old" }),
      startedAt: new Date(IN_WINDOW.getTime() - 7 * 3600_000).toISOString(),
      provider: "twilio",
      providerCallSid: "CAold",
      status: "ended",
      transcriptStatus: "pending",
    });
    bridge.state = st("ended", 61, true);
    bridge.rec = { sid: "RE1", status: "completed", durationSec: 61 };
    bridge.tx = { status: "ready", lines: LINES };
    responses.push(
      JSON.stringify({ outcome: "meeting_booked", note: "Tue 10am.", commitments: [] }),
    );
    const now = new Date(IN_WINDOW.getTime() + 10 * 60_000);
    expect(await sweepBridgedCalls({ bridge, now })).toEqual({ checked: 1, gaveUp: 1 });
    expect(ledger.getCall(orphan)).toMatchObject({
      status: "ended",
      transcriptStatus: "ready",
      suggestion: { outcome: "meeting_booked" },
    });
    expect(ledger.getCall(stale)?.transcriptStatus).toBe("failed");
    // Done: the next sweep has nothing left.
    expect(await sweepBridgedCalls({ bridge, now })).toEqual({ checked: 0, gaveUp: 0 });
  });

  it("idles with calls off or no keys", async () => {
    const bridge = fakeBridge();
    cfg = { calls: { enabled: false } };
    expect(await sweepBridgedCalls({ bridge })).toEqual({ checked: 0, gaveUp: 0 });
    cfg = { calls: { enabled: true } };
    expect(await sweepBridgedCalls({ bridge: null })).toEqual({ checked: 0, gaveUp: 0 });
  });
});

describe("the suggested outcome", () => {
  it("parses the model's JSON and falls back safely", () => {
    expect(
      parseCallOutcome(
        '```json\n{"outcome":"not_interested","note":"  Has a tool.  ","commitments":["  ", "call in Q2", 3]}\n```',
        { prospectSpoke: true },
      ),
    ).toEqual({ outcome: "not_interested", note: "Has a tool.", commitments: ["call in Q2"] });
    expect(parseCallOutcome('{"outcome":"maybe"}', { prospectSpoke: true })).toEqual({
      outcome: "not_now",
      note: "",
      commitments: [],
    });
    expect(parseCallOutcome("garbage", { prospectSpoke: false }).outcome).toBe("no_answer");
    const many = parseCallOutcome(
      JSON.stringify({
        outcome: "interested",
        note: "x".repeat(2000),
        commitments: Array.from({ length: 9 }, (_, i) => `c${i}`),
      }),
      { prospectSpoke: true },
    );
    expect(many.note).toHaveLength(600);
    expect(many.commitments).toHaveLength(5);
  });

  it("keeps the start and the end of a long transcript", () => {
    const long = Array.from({ length: 2000 }, (_, i) => ({
      speaker: i % 2 ? ("prospect" as const) : ("founder" as const),
      text: `sentence ${i}`,
      startSec: i * 2,
    }));
    const text = transcriptText(long);
    expect(text.length).toBeLessThan(16_100);
    expect(text).toContain("[0:00] CALLER: sentence 0");
    expect(text).toContain("the middle of the call is left out");
    expect(text).toContain("PROSPECT: sentence 1999");
  });
});

describe("member phones", () => {
  it("refuses a number another active member holds, whether or not Twilio lists it", async () => {
    getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "verified" });
    const bridge = fakeBridge();
    bridge.verified.add(MEMBER);
    await expect(verifyMemberPhone("mia@example.com", MEMBER, { bridge })).rejects.toMatchObject({
      status: 409,
      message: "that number is another member's phone",
    });
    expect(callsMe("mia@example.com", { bridge }).phone.status).toBe("none");
    // A removed member's old phone holds nothing.
    getSharedDb().addMember({ email: "gone@example.com", role: "member" });
    getSharedDb().removeMember("gone@example.com");
    getSharedDb().setMemberPhone({
      member: "gone@example.com",
      phone: "+14155550199",
      status: "verified",
    });
    bridge.verified.add("+14155550199");
    expect((await verifyMemberPhone("mia@example.com", "+14155550199", { bridge })).status).toBe(
      "verifying",
    );
    getSharedDb().deleteMemberPhone("gone@example.com");
  });

  it("keeps the phone when Twilio cannot remove it, and needs the keys to remove it", async () => {
    getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "verified" });
    const failing = fakeBridge({
      removeCallerId: async () => {
        throw new CallBridgeError("Twilio: down", 503);
      },
    });
    await expect(removeMemberPhone(null, { bridge: failing })).rejects.toMatchObject({
      status: 502,
    });
    await expect(removeMemberPhone(null, { bridge: null })).rejects.toMatchObject({ status: 409 });
    expect(callsMe(null, { bridge: failing }).phone.phone).toBe(MEMBER);
  });

  it("keeps a phone stored while Twilio was removing the old one", async () => {
    getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "verified" });
    const bridge = fakeBridge({
      removeCallerId: vi.fn(async () => {
        getSharedDb().setMemberPhone({
          member: "",
          phone: "+14155550122",
          status: "verifying",
          validationCode: "111111",
        });
      }),
    });
    expect(await removeMemberPhone(null, { bridge })).toMatchObject({
      phone: "+14155550122",
      status: "verifying",
    });
  });

  it("verifies a new phone with a code, then flips to verified once listed", async () => {
    const bridge = fakeBridge();
    const view = await verifyMemberPhone("Mia@Example.com", "(415) 555-0111", { bridge });
    expect(bridge.verifyCallerId).toHaveBeenCalledWith(MEMBER);
    expect(view).toEqual({
      phone: MEMBER,
      status: "verifying",
      validationCode: "654321",
      verifiedAt: null,
      error: null,
    });
    expect(callsMe("mia@example.com", { bridge })).toMatchObject({
      bridgeReady: true,
      record: "always",
      phone: { status: "verifying" },
    });
    expect(memberCanBridge("mia@example.com", { bridge })).toBe(false);
    expect((await checkMemberPhone("mia@example.com", { bridge })).status).toBe("verifying");
    bridge.verified.add(MEMBER);
    const done = await checkMemberPhone("mia@example.com", { bridge });
    expect(done).toMatchObject({ status: "verified", validationCode: null });
    expect(done.verifiedAt).toBeTruthy();
    expect(memberCanBridge("mia@example.com", { bridge })).toBe(true);
    // Members do not share phones: the local owner has none.
    expect(callsMe(null, { bridge }).phone.status).toBe("none");
    expect((await removeMemberPhone("mia@example.com", { bridge })).status).toBe("none");
    expect(bridge.removeCallerId).toHaveBeenCalledWith(MEMBER);
    expect(callsMe("mia@example.com", { bridge }).phone.phone).toBeNull();
  });

  it("needs this member's own code for a number the account already lists", async () => {
    const bridge = fakeBridge();
    // Left on the account by someone who has since moved to another phone.
    bridge.verified.add(MEMBER);
    expect(await verifyMemberPhone(null, MEMBER, { bridge })).toMatchObject({
      status: "verifying",
      validationCode: "654321",
    });
    expect(bridge.removeCallerId).toHaveBeenCalledWith(MEMBER);
    expect(bridge.verifyCallerId).toHaveBeenCalledWith(MEMBER);
    // Their code typed: Verify again (or the check) sees it listed and marks it verified.
    bridge.verified.add(MEMBER);
    expect((await verifyMemberPhone(null, MEMBER, { bridge })).status).toBe("verified");
    expect((await verifyMemberPhone(null, MEMBER, { bridge })).status).toBe("verified");
    expect(bridge.verifyCallerId).toHaveBeenCalledTimes(1);
  });

  it("stores a provider refusal as failed, times out an unfinished code, and refuses bad input", async () => {
    const refusing = fakeBridge({
      verifyCallerId: async () => {
        throw new CallBridgeError("Twilio: The phone number is invalid", 400, 21212);
      },
    });
    await expect(verifyMemberPhone(null, MEMBER, { bridge: refusing })).rejects.toMatchObject({
      status: 502,
    });
    expect(callsMe(null, { bridge: refusing }).phone).toMatchObject({
      status: "failed",
      error: "Twilio: The phone number is invalid",
    });

    const bridge = fakeBridge();
    await verifyMemberPhone(null, MEMBER, { bridge });
    const late = new Date(Date.now() + VERIFY_TIMEOUT_MS + 60_000);
    expect(await checkMemberPhone(null, { bridge, now: late })).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/not entered in time/),
    });

    await expect(verifyMemberPhone(null, "call me", { bridge })).rejects.toMatchObject({
      status: 400,
    });
    await expect(verifyMemberPhone(null, MEMBER, { bridge: null })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Twilio keys/),
    });
    await removeMemberPhone(null, { bridge });
    await expect(checkMemberPhone(null, { bridge })).rejects.toMatchObject({ status: 409 });
    expect(callsMe(null, { bridge: null }).bridgeReady).toBe(false);
  });
});

describe("the next email knows about the call", () => {
  it("lists logged calls with their note and confirmed promises, newest first", () => {
    const id = prospect();
    expect(buildPriorCallsBlock(id)).toBeNull();
    ledger.insertCall({ prospectId: id, startedAt: "2026-11-10T10:00:00Z" }); // never logged
    recordCall(id, { outcome: "wrong_number" }, new Date("2026-11-11T10:00:00Z"));
    expect(buildPriorCallsBlock(id)).toBeNull();
    recordCall(id, { outcome: "voicemail" }, new Date("2026-11-12T10:00:00Z"));
    const bridged = ledger.insertCall({
      prospectId: id,
      startedAt: "2026-11-17T10:00:00Z",
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
    });
    ledger.updateBridgedCall(bridged, {
      suggestion: {
        outcome: "interested",
        note: "n",
        commitments: ["send the pilot terms Thursday"],
      },
    });
    // Logged without confirming the suggested promise: it never reaches an email.
    recordCall(
      id,
      { outcome: "interested", note: "Wants a pilot\nfor two teams.", callId: bridged },
      new Date("2026-11-17T10:05:00Z"),
    );
    expect(buildPriorCallsBlock(id)).not.toContain("Promised");
    recordCall(
      id,
      { outcome: "interested", callId: bridged, commitments: ["send the pilot terms Thursday"] },
      new Date("2026-11-17T10:06:00Z"),
    );
    const block = buildPriorCallsBlock(id)!;
    expect(block.split("\n")).toEqual([
      expect.stringMatching(/^PRIOR CALLS \(/),
      "- 2026-11-17: Interested",
      "  Note: Wants a pilot for two teams.",
      "  Promised: send the pilot terms Thursday",
      "- 2026-11-12: Left voicemail",
    ]);
    expect(block).not.toContain("Wrong number");
  });
});

describe("calls a teammate made, in the next email", () => {
  it("names a colleague's call and keeps a long promise whole", () => {
    getSharedDb().addMember({ email: "jo@example.com", name: "Jo Park", role: "member" });
    try {
      const id = prospect();
      const promise = `send the pilot terms ${"x".repeat(230)} only after procurement approves`;
      const placed = (member: string | null, at: string) =>
        ledger.insertCall({
          prospectId: id,
          startedAt: at,
          provider: "twilio",
          providerCallSid: `CA${at}`,
          status: "ended",
          member,
        });
      const jo = placed("jo@example.com", "2026-11-17T10:00:00Z");
      recordCall(id, { outcome: "interested", callId: jo, commitments: [promise] });
      const own = placed(null, "2026-11-16T10:00:00Z");
      recordCall(id, { outcome: "voicemail", callId: own });
      const lines = buildPriorCallsBlock(id, "Sam")!.split("\n");
      expect(lines).toContain("- 2026-11-17: Interested (by Jo Park)");
      expect(lines).toContain("- 2026-11-16: Left voicemail");
      expect(lines.find((l) => l.startsWith("  Promised:"))).toContain(
        "only after procurement approves",
      );
      expect(lines[0]).toMatch(/colleague/);
      // Jo writing as the sender: their own call is theirs.
      expect(buildPriorCallsBlock(id, "Jo Park")).toContain("- 2026-11-17: Interested\n");
    } finally {
      getSharedDb().removeMember("jo@example.com");
    }
  });

  it("confirms promises only on a bridged call", () => {
    const id = prospect();
    expect(() => recordCall(id, { outcome: "interested", commitments: ["send it"] })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(recordCall(id, { outcome: "interested", commitments: [] }).provider).toBe("tel");
  });
});

describe("the mode and the gates as they are when the prospect is dialled", () => {
  async function held(bridge: Fake): Promise<number> {
    verifyOwner();
    const call = await startBridgedCall({
      prospectId: prospect(),
      member: null,
      now: IN_WINDOW,
      bridge,
    });
    bridge.state = st("ringing_prospect", null, false, "human");
    return call.id;
  }

  it("records from the answer only if the mode is still always, and dials nobody once bridging is off", async () => {
    const bridge = fakeBridge();
    const id = await held(bridge);
    expect(ledger.getCall(id)?.transcriptStatus).toBe("pending");
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "ask" } } };
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    expect(vi.mocked(bridge.connect).mock.calls[0]![1].record).toBe(false);
    expect(ledger.getCall(id)).toMatchObject({ transcriptStatus: "none" });
    expect(ledger.getCall(id)).not.toHaveProperty("recordedFrom");

    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "always" } } };
    const other = await held(bridge);
    await refreshBridgedCall(other, { bridge, now: IN_WINDOW });
    expect(vi.mocked(bridge.connect).mock.calls[1]![1].record).toBe(true);
    expect(ledger.getCall(other)).toMatchObject({
      transcriptStatus: "pending",
      recordedFrom: "answer",
    });

    const third = await held(bridge);
    cfg = { calls: { enabled: true, bridge: null } };
    expect(await refreshBridgedCall(third, { bridge, now: IN_WINDOW })).toMatchObject({
      status: "failed",
      statusReason: "bridged calls were turned off, so nobody was dialled",
    });
    expect(bridge.connect).toHaveBeenCalledTimes(2);
  });

  it("judges the call window by the clock after the provider answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(IN_WINDOW);
      const bridge = fakeBridge();
      const id = await held(bridge);
      vi.mocked(bridge.status).mockImplementationOnce(async () => {
        // 17:30 in Chicago by the time Twilio answers.
        vi.setSystemTime(new Date("2026-11-18T23:30:00Z"));
        return st("ringing_prospect", null, false, "human");
      });
      expect((await refreshBridgedCall(id, { bridge })).statusReason).toMatch(/call hours closed/);
      expect(bridge.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks recording is still on after reading the call, and leaves Record free", async () => {
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "ask" } } };
    const bridge = fakeBridge();
    const id = await held(bridge);
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW });
    vi.mocked(bridge.status).mockImplementationOnce(async () => {
      cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: false } } };
      return st("connected", 5, true);
    });
    await expect(startBridgedRecording(id, { bridge })).rejects.toMatchObject({ status: 409 });
    expect(bridge.startRecording).not.toHaveBeenCalled();
    expect(ledger.getCall(id)?.transcriptStatus).toBe("none");
  });
});

describe("who may act on a bridged call", () => {
  it("lets the caller hang up and record; an owner may also delete the recording", () => {
    const id = ledger.insertCall({
      prospectId: prospect(),
      startedAt: IN_WINDOW.toISOString(),
      provider: "twilio",
      providerCallSid: "CA1",
      member: "jo@example.com",
      status: "connected",
    });
    const jo = { email: "Jo@Example.com", role: "member" as const };
    const sam = { email: "sam@example.com", role: "member" as const };
    const owner = { email: "owner@example.com", role: "owner" as const };
    for (const action of ["hangup", "record", "discard"] as const)
      expect(() => assertCallActor(id, jo, action)).not.toThrow();
    for (const action of ["hangup", "record", "discard"] as const)
      expect(() => assertCallActor(id, sam, action)).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    expect(() => assertCallActor(id, owner, "record")).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertCallActor(id, owner, "discard")).not.toThrow();
    // The unlisted local owner's call belongs to every owner.
    const local = ledger.insertCall({
      prospectId: prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" }),
      startedAt: IN_WINDOW.toISOString(),
      provider: "twilio",
      providerCallSid: "CA2",
      status: "connected",
    });
    expect(() => assertCallActor(local, owner, "hangup")).not.toThrow();
    expect(() => assertCallActor(local, sam, "hangup")).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertCallActor(9999, owner, "hangup")).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe("declined recordings that are slow or failing to delete", () => {
  function declinedCall(
    over: { startedAt?: string; recordedFrom?: boolean; recordingSid?: string } = {},
  ): number {
    const id = ledger.insertCall({
      prospectId: prospect({ email: `p${Math.random()}@acme.test`, name: "P" }),
      startedAt: over.startedAt ?? IN_WINDOW.toISOString(),
      provider: "twilio",
      providerCallSid: "CA1",
      status: "ended",
      transcriptStatus: "pending",
    });
    if (over.recordedFrom)
      ledger.updateBridgedCall(id, {
        recordingFrom: "answer",
        recordingRequestedAt: IN_WINDOW.toISOString(),
      });
    if (over.recordingSid) ledger.updateBridgedCall(id, { recordingSid: over.recordingSid });
    ledger.markRecordingDiscard(id);
    return id;
  }

  it("keeps looking for a recording that was asked for, then gives up after a week", async () => {
    const bridge = fakeBridge();
    const asked = declinedCall({ recordedFrom: true });
    const never = declinedCall();
    const later = new Date(IN_WINDOW.getTime() + 60 * 60_000);
    await sweepBridgedCalls({ bridge, now: later });
    expect(ledger.getBridgedCall(never)?.discardPending).toBe(false);
    expect(ledger.getBridgedCall(asked)?.discardPending).toBe(true);
    bridge.rec = { sid: "RElate", status: "completed", durationSec: 30 };
    await sweepBridgedCalls({ bridge, now: new Date(later.getTime() + 2 * 3600_000) });
    expect(bridge.deleteRecording).toHaveBeenCalledWith("RElate");
    expect(ledger.getBridgedCall(asked)?.discardPending).toBe(false);

    const quiet = declinedCall({ recordedFrom: true });
    bridge.rec = null;
    await sweepBridgedCalls({ bridge, now: new Date(IN_WINDOW.getTime() + 8 * 24 * 3600_000) });
    expect(ledger.getBridgedCall(quiet)?.discardPending).toBe(false);
  });

  it("puts a deletion that failed behind the others, and still deletes with Calls off", async () => {
    const old = (n: number) =>
      new Date(IN_WINDOW.getTime() - (5 * 24 + n) * 3600_000).toISOString();
    const failing = [1, 2, 3, 4, 5].map((n) =>
      declinedCall({ startedAt: old(10 - n), recordingSid: `REfail${n}` }),
    );
    const sixth = declinedCall({ startedAt: old(0), recordingSid: "REok" });
    const bridge = fakeBridge({
      deleteRecording: vi.fn(async (sid: string) => {
        if (sid !== "REok") throw new CallBridgeError("Twilio: down", 503);
      }),
    });
    await sweepBridgedCalls({ bridge, now: IN_WINDOW });
    expect(ledger.getBridgedCall(sixth)?.discardPending).toBe(true);
    // The five failed and wait; the sixth gets its turn.
    cfg = { calls: { enabled: false, bridge: { provider: "twilio" } } };
    expect(
      (await sweepBridgedCalls({ bridge, now: new Date(IN_WINDOW.getTime() + 60_000) })).checked,
    ).toBe(1);
    expect(ledger.getBridgedCall(sixth)?.discardPending).toBe(false);
    expect(ledger.getBridgedCall(failing[0]!)?.discardPending).toBe(true);
  });
});

describe("a failed phone needs a fresh Verify", () => {
  it("stays failed even once Twilio lists the number", async () => {
    const bridge = fakeBridge();
    getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "failed", error: "x" });
    bridge.verified.add(MEMBER);
    expect((await checkMemberPhone(null, { bridge })).status).toBe("failed");
  });
});

describe("the suggestion's JSON", () => {
  it("falls back when the model answers something that is not an object", () => {
    for (const content of ["null", "[1,2]", '"interested"', "42"])
      expect(parseCallOutcome(content, { prospectSpoke: true })).toEqual({
        outcome: "not_now",
        note: "",
        commitments: [],
      });
  });
});
