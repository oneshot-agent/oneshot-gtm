import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";
import {
  CallBridgeError,
  getSharedDb,
  type BridgeCallState,
  type CallBridge,
} from "@oneshot-gtm/core";

// The live bar's read (`liveCalls`) and the one-call-at-a-time guard on
// `startBridgedCall`, over a real in-memory ledger and a fake provider.

let ledger: Ledger;
let cfg: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, loadConfig: () => cfg, logEvent: () => {} };
});

const {
  liveCalls,
  startBridgedCall,
  refreshBridgedCall,
  settleBridgedCallWork,
  setBridgedRecordingPaused,
  startBridgedRecording,
} = await import("../src/_call-bridge.ts");

const MEMBER = "+14155550111";
const TEAMMATE = "mia@example.com";
const TEAMMATE_PHONE = "+14155550122";
const PROSPECT = "+15126531187"; // Austin: America/Chicago
/** Wednesday 10:00 in Chicago. */
const NOW = new Date("2026-11-18T16:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function fakeBridge(state: BridgeCallState): CallBridge & { status: ReturnType<typeof vi.fn> } {
  return {
    accountSid: "AC1",
    verifyCallerId: vi.fn(async () => ({ validationCode: "1" })),
    isVerified: vi.fn(async () => true),
    start: vi.fn(async () => ({ callSid: "CAnew" })),
    connect: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {}),
    setRecordingPaused: vi.fn(async () => {}),
    removeCallerId: vi.fn(async () => {}),
    deleteRecording: vi.fn(async () => {}),
    transcriptsFor: vi.fn(async () => []),
    deleteTranscript: vi.fn(async () => {}),
    status: vi.fn(async () => state),
    hangUp: vi.fn(async () => {}),
    recording: vi.fn(async () => null),
    ensureService: vi.fn(async () => "GA1"),
    transcribe: vi.fn(async () => ({ transcriptSid: "GT1" })),
    transcript: vi.fn(async () => ({ status: "pending" as const })),
  };
}

const connected: BridgeCallState = {
  status: "connected",
  durationSec: null,
  answered: true,
  answeredBy: "human",
};

function prospect(name: string, email: string, phone = PROSPECT): number {
  return ledger.upsertProspect({ name, email, company: "Acme", phone });
}

function call(input: {
  prospectId: number;
  member: string | null;
  status: "ringing_founder" | "ringing_prospect" | "connected" | "ended" | "failed";
  startedAt: string;
  outcome?: "no_answer" | null;
}): number {
  const id = ledger.insertCall({
    prospectId: input.prospectId,
    startedAt: input.startedAt,
    phone: PROSPECT,
    provider: "twilio",
    providerCallSid: `CA${Math.random().toString(36).slice(2, 8)}`,
    member: input.member,
    memberPhone: input.member ? TEAMMATE_PHONE : MEMBER,
    status: input.status,
    transcriptStatus: "none",
    ...(input.outcome ? { outcome: input.outcome } : {}),
  });
  // Past the hold, so a read follows the call instead of deciding the dial.
  ledger.claimBridge(id, input.startedAt);
  return id;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "ask" } } };
  getSharedDb().setMemberPhone({ member: "", phone: MEMBER, status: "verified", verifiedAt: "t" });
});
afterEach(async () => {
  await settleBridgedCallWork();
  getSharedDb().deleteMemberPhone("");
  ledger.close();
});

describe("connected_at", () => {
  it("is written by the first read that finds the call connected, and never again", async () => {
    const id = call({
      prospectId: prospect("Dana", "dana@acme.test"),
      member: null,
      status: "ringing_prospect",
      startedAt: ago(MIN),
    });
    expect(ledger.getCall(id)?.connectedAt).toBeUndefined();
    const bridge = fakeBridge(connected);
    const first = (await refreshBridgedCall(id, { bridge, now: NOW })).connectedAt;
    expect(first).toEqual(expect.any(String));
    await new Promise((r) => setTimeout(r, 5));
    expect((await refreshBridgedCall(id, { bridge, now: NOW })).connectedAt).toBe(first);
  });
});

describe("liveCalls", () => {
  it("is off with calls or the bridge off", async () => {
    cfg = { calls: { enabled: false } };
    expect(await liveCalls(null, { bridge: fakeBridge(connected), now: NOW })).toEqual({
      enabled: false,
      record: false,
      calls: [],
    });
    cfg = { calls: { enabled: true, bridge: null } };
    expect((await liveCalls(null, { bridge: fakeBridge(connected), now: NOW })).enabled).toBe(
      false,
    );
  });

  it("shows everyone's live calls and only my own unlogged ended ones, and reads only mine", async () => {
    const dana = prospect("Dana", "dana@acme.test");
    const lee = prospect("Lee", "lee@acme.test", "+15126531188");
    const kim = prospect("Kim", "kim@acme.test", "+15126531189");
    const mine = call({ prospectId: dana, member: null, status: "connected", startedAt: ago(MIN) });
    const theirs = call({
      prospectId: lee,
      member: TEAMMATE,
      status: "connected",
      startedAt: ago(2 * MIN),
    });
    const myEnded = call({ prospectId: kim, member: null, status: "ended", startedAt: ago(HOUR) });
    call({ prospectId: kim, member: TEAMMATE, status: "ended", startedAt: ago(HOUR) });
    call({
      prospectId: kim,
      member: null,
      status: "ended",
      startedAt: ago(HOUR),
      outcome: "no_answer",
    });
    call({ prospectId: kim, member: null, status: "ended", startedAt: ago(7 * HOUR) });
    // Marked live but older than any call can last: stale, not live.
    call({ prospectId: kim, member: TEAMMATE, status: "connected", startedAt: ago(5 * HOUR) });

    const bridge = fakeBridge(connected);
    const out = await liveCalls(null, { bridge, now: NOW });
    expect(out).toMatchObject({ enabled: true, record: "ask" });
    expect(out.calls.map((c) => [c.id, c.mine, c.prospectName])).toEqual([
      [mine, true, "Dana"],
      [theirs, false, "Lee"],
      [myEnded, true, "Kim"],
    ]);
    expect(out.calls.every((c) => !("transcript" in c))).toBe(true);
    // My live call and my ended one were read from the provider; the teammate's was not.
    const read = bridge.status.mock.calls.map((c) => c[0]);
    expect(read).toContain(ledger.getBridgedCall(mine)?.callSid);
    expect(read).not.toContain(ledger.getBridgedCall(theirs)?.callSid);
    expect(out.calls[0]?.connectedAt).toEqual(expect.any(String));
  });
});

describe("my unlogged calls on a busy team", () => {
  it("are not crowded out by teammates' newer unlogged calls", async () => {
    const kim = prospect("Kim", "kim@acme.test", "+15126531189");
    const myOld = call({
      prospectId: kim,
      member: null,
      status: "ended",
      startedAt: ago(2 * HOUR),
    });
    for (let i = 0; i < 5; i++)
      call({ prospectId: kim, member: TEAMMATE, status: "ended", startedAt: ago(10 * MIN + i) });
    const out = await liveCalls(null, { bridge: fakeBridge(connected), now: NOW });
    expect(out.calls.map((c) => c.id)).toEqual([myOld]);
    // A teammate with a differently cased address still reads only theirs.
    const theirs = await liveCalls(" Mia@Example.com ", {
      bridge: fakeBridge(connected),
      now: NOW,
    });
    // Every unlogged one stays on their bar until it is logged, not only the newest few.
    expect(theirs.calls).toHaveLength(5);
    expect(theirs.calls.every((c) => c.mine)).toBe(true);
  });
});

describe("one call at a time", () => {
  const start = (prospectId: number, bridge: CallBridge) =>
    startBridgedCall({ prospectId, member: null, now: NOW, bridge }).then(
      (v) => v.id,
      (e: { status: number; message: string }) => [e.status, e.message] as const,
    );

  it("refuses a call to someone a teammate is on a call with", async () => {
    const dana = prospect("Dana", "dana@acme.test");
    call({ prospectId: dana, member: TEAMMATE, status: "connected", startedAt: ago(MIN) });
    const bridge = fakeBridge(connected);
    expect(await start(dana, bridge)).toEqual([409, `${TEAMMATE} is already on a call with them`]);
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("refuses a second call from a member already on one", async () => {
    const dana = prospect("Dana", "dana@acme.test");
    const lee = prospect("Lee", "lee@acme.test", "+15126531188");
    call({ prospectId: dana, member: null, status: "ringing_prospect", startedAt: ago(MIN) });
    expect(await start(lee, fakeBridge({ ...connected, status: "ringing_prospect" }))).toEqual([
      409,
      "hang up your other call first",
    ]);
  });

  it("lets the call go when the one in the way turns out to be over", async () => {
    const dana = prospect("Dana", "dana@acme.test");
    call({ prospectId: dana, member: TEAMMATE, status: "connected", startedAt: ago(MIN) });
    const over: BridgeCallState = {
      status: "ended",
      durationSec: 30,
      answered: true,
      answeredBy: "human",
    };
    expect(await start(dana, fakeBridge(over))).toEqual(expect.any(Number));
  });

  it("refuses a second start while the first still waits on the provider", async () => {
    const dana = prospect("Dana", "dana@acme.test");
    let release!: () => void;
    const bridge = fakeBridge(connected);
    bridge.start = vi.fn(
      () =>
        new Promise<{ callSid: string }>((resolve) => {
          release = () => resolve({ callSid: "CAslow" });
        }),
    );
    const first = start(dana, bridge);
    const second = await start(dana, bridge);
    expect(second).toEqual([409, "a call is already being placed; wait a moment"]);
    release();
    expect(await first).toEqual(expect.any(Number));
    expect(bridge.start).toHaveBeenCalledTimes(1);
  });
});

describe("Stop recording", () => {
  function recorded(status: "connected" | "ringing_prospect" = "connected"): number {
    const id = call({
      prospectId: prospect("Dana", "dana@acme.test"),
      member: null,
      status,
      startedAt: ago(MIN),
    });
    ledger.updateBridgedCall(id, { transcriptStatus: "pending", recordingFrom: "answer" });
    return id;
  }

  it("pauses the recording without hanging up, and Record resumes it", async () => {
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: "always" } } };
    const id = recorded();
    const bridge = fakeBridge(connected);
    expect((await setBridgedRecordingPaused(id, true, { bridge })).recordingPaused).toBe(true);
    expect(bridge.setRecordingPaused).toHaveBeenLastCalledWith(
      ledger.getBridgedCall(id)?.callSid,
      true,
    );
    expect(bridge.hangUp).not.toHaveBeenCalled();
    // Stop again: already stopped, Twilio is not asked twice.
    await setBridgedRecordingPaused(id, true, { bridge });
    expect(bridge.setRecordingPaused).toHaveBeenCalledTimes(1);
    // Record resumes the same recording rather than starting another.
    const resumed = await startBridgedRecording(id, { bridge });
    expect(resumed.recordingPaused).toBeUndefined();
    expect(resumed.transcriptStatus).toBe("pending");
    expect(bridge.setRecordingPaused).toHaveBeenLastCalledWith(
      ledger.getBridgedCall(id)?.callSid,
      false,
    );
    expect(bridge.startRecording).not.toHaveBeenCalled();
  });

  it("refuses when nothing is recorded or the call is not connected", async () => {
    const bridge = fakeBridge(connected);
    const notRecorded = call({
      prospectId: prospect("Lee", "lee@acme.test", "+15126531188"),
      member: null,
      status: "connected",
      startedAt: ago(MIN),
    });
    await expect(setBridgedRecordingPaused(notRecorded, true, { bridge })).rejects.toMatchObject({
      status: 409,
      message: "nothing is being recorded on this call",
    });
    const ringing = recorded("ringing_prospect");
    await expect(setBridgedRecordingPaused(ringing, true, { bridge })).rejects.toMatchObject({
      status: 409,
    });
    expect(bridge.setRecordingPaused).not.toHaveBeenCalled();
  });

  it("applies a quick Stop then Record in the order pressed, even when Stop is slow", async () => {
    const id = recorded();
    const bridge = fakeBridge(connected);
    const order: boolean[] = [];
    let releaseStop!: () => void;
    bridge.setRecordingPaused = vi.fn(async (_sid: string, paused: boolean) => {
      if (paused) await new Promise<void>((r) => (releaseStop = r));
      order.push(paused);
    });
    const stop = setBridgedRecordingPaused(id, true, { bridge });
    const record = setBridgedRecordingPaused(id, false, { bridge });
    await new Promise((r) => setTimeout(r, 5));
    releaseStop();
    await stop;
    expect((await record).recordingPaused).toBeUndefined();
    expect(order).toEqual([true, false]);
    expect(ledger.getCall(id)?.recordingPaused).toBeUndefined();
  });

  it("sends the next press when Twilio did not confirm the last one", async () => {
    const id = recorded();
    const bridge = fakeBridge(connected);
    bridge.setRecordingPaused = vi
      .fn()
      .mockRejectedValueOnce(new CallBridgeError("timed out", 502, undefined, true))
      .mockResolvedValue(undefined);
    await expect(setBridgedRecordingPaused(id, true, { bridge })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/did not confirm/),
    });
    // Nothing recorded as stopped: the ledger still says recording.
    expect(ledger.getCall(id)?.recordingPaused).toBeUndefined();
    // Record now: the ledger already reads recording, but Twilio may have paused, so it is sent.
    await setBridgedRecordingPaused(id, false, { bridge });
    expect(bridge.setRecordingPaused).toHaveBeenCalledTimes(2);
    // Confirmed now: a second Record has nothing to send.
    await setBridgedRecordingPaused(id, false, { bridge });
    expect(bridge.setRecordingPaused).toHaveBeenCalledTimes(2);
  });
});
