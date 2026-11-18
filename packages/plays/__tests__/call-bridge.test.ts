import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";
import {
  ALREADY_VERIFIED_CODE,
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

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, loadConfig: () => cfg, logEvent: () => {} };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => `prompt:${name}`,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      prompts.push(input.messages.map((m) => m.content).join("\n"));
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

function fakeBridge(over: Partial<CallBridge> = {}): Fake {
  const fake: Fake = {
    state: { status: "ringing_founder", durationSec: null, answered: false },
    rec: null,
    tx: { status: "pending" },
    verified: new Set(),
    verifyCallerId: vi.fn(async () => ({ validationCode: "654321" })),
    isVerified: vi.fn(async (phone: string) => fake.verified.has(phone)),
    start: vi.fn(async () => ({ callSid: "CA1" })),
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
    calls: { enabled: true, bridge: { provider: "twilio", transcriptionServiceSid: "GAcfg" } },
  };
  responses.length = 0;
  prompts.length = 0;
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
    expect(bridge.start).toHaveBeenCalledWith({
      memberPhone: MEMBER,
      prospectPhone: PROSPECT,
      sayName: "Dana at Acme",
      record: true,
    });
    expect(call).toMatchObject({
      prospectId: id,
      playName: "renewals",
      member: "mia@example.com",
      provider: "twilio",
      status: "ringing_founder",
      transcriptStatus: "pending",
      outcome: null,
    });
    expect(ledger.getBridgedCall(call.id)).toMatchObject({ callSid: "CA1", phone: PROSPECT });
  });

  it("does not record when record is off, and writes nothing when the provider refuses", async () => {
    verifyOwner();
    const id = prospect();
    cfg = { calls: { enabled: true, bridge: { provider: "twilio", record: false } } };
    const bridge = fakeBridge();
    const call = await startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge });
    expect(call.transcriptStatus).toBe("none");
    expect(vi.mocked(bridge.start).mock.calls[0]![0].record).toBe(false);

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

describe("following a bridged call", () => {
  async function placed(bridge: Fake): Promise<number> {
    verifyOwner();
    const id = prospect();
    return (await startBridgedCall({ prospectId: id, member: null, now: IN_WINDOW, bridge })).id;
  }

  it("stores the live state, then advances recording, transcript and suggestion", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    const later = new Date(IN_WINDOW.getTime() + 60_000);
    bridge.state = { status: "connected", durationSec: 12, answered: true };
    expect(await refreshBridgedCall(id, { bridge, now: later, wait: true })).toMatchObject({
      status: "connected",
      durationSec: 12,
      transcriptStatus: "pending",
    });
    expect(bridge.recording).not.toHaveBeenCalled();

    bridge.state = { status: "ended", durationSec: 61, answered: true };
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

  it("returns at once without wait, the work finishing in the background", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    bridge.state = { status: "ended", durationSec: 30, answered: true };
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
    bridge.state = { status: "ended", durationSec: null, answered: false };
    expect(
      await refreshBridgedCall(unanswered, { bridge, now: IN_WINDOW, wait: true }),
    ).toMatchObject({ status: "ended", transcriptStatus: "none" });
    expect(bridge.recording).not.toHaveBeenCalled();

    const other = prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" });
    const id = (await startBridgedCall({ prospectId: other, member: null, now: IN_WINDOW, bridge }))
      .id;
    bridge.state = { status: "ended", durationSec: 40, answered: true };
    bridge.rec = { sid: "RE2", status: "completed", durationSec: 40 };
    bridge.tx = { status: "failed" };
    expect(await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true })).toMatchObject({
      transcriptStatus: "failed",
    });
  });

  it("gives up on a recording that never appears, and on one too short to transcribe", async () => {
    const bridge = fakeBridge();
    const id = await placed(bridge);
    bridge.state = { status: "ended", durationSec: 20, answered: true };
    await refreshBridgedCall(id, { bridge, now: IN_WINDOW, wait: true });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("pending");
    await refreshBridgedCall(id, {
      bridge,
      now: new Date(IN_WINDOW.getTime() + 20 * 60_000),
      wait: true,
    });
    expect(ledger.getCall(id)?.transcriptStatus).toBe("none");

    const other = prospect({ email: "b@acme.test", phone: "+15126531188", name: "Bo" });
    const short = (
      await startBridgedCall({ prospectId: other, member: null, now: IN_WINDOW, bridge })
    ).id;
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
    const orphan = (
      await startBridgedCall({ prospectId: prospect(), member: null, now: IN_WINDOW, bridge })
    ).id;
    const stale = ledger.insertCall({
      prospectId: prospect({ email: "old@acme.test", name: "Old" }),
      startedAt: new Date(IN_WINDOW.getTime() - 7 * 3600_000).toISOString(),
      provider: "twilio",
      providerCallSid: "CAold",
      status: "ended",
      transcriptStatus: "pending",
    });
    bridge.state = { status: "ended", durationSec: 61, answered: true };
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
      record: true,
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
    expect(removeMemberPhone("mia@example.com").status).toBe("none");
    expect(callsMe("mia@example.com", { bridge }).phone.phone).toBeNull();
  });

  it("marks a number the account already verified at once", async () => {
    const bridge = fakeBridge();
    bridge.verified.add(MEMBER);
    expect((await verifyMemberPhone(null, MEMBER, { bridge })).status).toBe("verified");
    expect(bridge.verifyCallerId).not.toHaveBeenCalled();
    const racing = fakeBridge({
      verifyCallerId: async () => {
        throw new CallBridgeError("Twilio: already verified", 400, ALREADY_VERIFIED_CODE);
      },
    });
    expect((await verifyMemberPhone(null, MEMBER, { bridge: racing })).status).toBe("verified");
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
    removeMemberPhone(null);
    await expect(checkMemberPhone(null, { bridge })).rejects.toMatchObject({ status: 409 });
    expect(callsMe(null, { bridge: null }).bridgeReady).toBe(false);
  });
});

describe("the next email knows about the call", () => {
  it("lists logged calls with their note and promises, newest first", () => {
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
    recordCall(
      id,
      { outcome: "interested", note: "Wants a pilot\nfor two teams.", callId: bridged },
      new Date("2026-11-17T10:05:00Z"),
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
