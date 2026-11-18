import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CallListResponse,
  CallListRow,
  CallRecordView,
  CallsMeResponse,
  MemberPhoneView,
} from "@oneshot-gtm/shared-types";
import { api } from "../src/api/client.ts";
import {
  BridgeCallView,
  callKey,
  CallHistory,
  TranscriptView,
} from "../src/components/calls/DialPanel.tsx";
import { callsMeKey, YourPhoneView } from "../src/components/setup/YourPhone.tsx";
import { CallsSection } from "../src/components/setup/CallsSection.tsx";
import { CallsView } from "../src/routes/calls.tsx";
import {
  bridgePollMs,
  bridgeStatusLine,
  callerLabel,
  CONSENT_LINE,
  firstName,
  isLive,
  LIVE_POLL_MS,
  resumableCall,
  suggestedPick,
  TRANSCRIPT_POLL_MS,
  transcriptTurns,
} from "../src/lib/bridgeCall.ts";
import { dialReducer, logCallRequest, type DialState } from "../src/lib/dialler.ts";
import {
  phoneInputError,
  pollVerification,
  verifyFailure,
  yourPhoneScreen,
} from "../src/lib/memberPhone.ts";

// Phase 2 of the dialler in the browser: each member's own phone, and the
// bridged call (live state, transcript, suggested outcome) in the dial panel.

const privacy = vi.hoisted(() => ({ masked: false }));
vi.mock("../src/lib/privacy.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/privacy.tsx")>();
  const { applyMask } = await import("../src/lib/mask.ts");
  return {
    ...actual,
    usePrivacy: () => ({ masked: privacy.masked, setMasked: () => {} }),
    useMask: () => (kind: Parameters<typeof applyMask>[1], value: string | null | undefined) =>
      applyMask(privacy.masked, kind, value),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      hash,
      children,
      className,
    }: {
      to: string;
      hash?: string;
      children: ReactNode;
      className?: string;
    }) => (
      <a href={`${to}${hash ? `#${hash}` : ""}`} className={className}>
        {children}
      </a>
    ),
  };
});

const NOW = new Date("2026-11-18T16:05:00Z");
let client = new QueryClient();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  client.clear();
  client = new QueryClient();
  privacy.masked = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const render = (node: ReactElement) =>
  renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);

const phone = (over: Partial<MemberPhoneView> = {}): MemberPhoneView => ({
  phone: null,
  status: "none",
  validationCode: null,
  verifiedAt: null,
  error: null,
  ...over,
});
const me = (over: Partial<CallsMeResponse> = {}): CallsMeResponse => ({
  bridgeReady: true,
  phone: phone(),
  record: true,
  ...over,
});
const call = (over: Partial<CallRecordView> = {}): CallRecordView => ({
  id: 7,
  prospectId: 1,
  playName: "post-funding",
  member: "jo@oneshot.dev",
  startedAt: "2026-11-18T16:00:00Z",
  durationSec: null,
  outcome: null,
  note: null,
  provider: "twilio",
  status: "connected",
  transcriptStatus: "none",
  transcript: null,
  suggestion: null,
  ...over,
});
const transcript: NonNullable<CallRecordView["transcript"]> = [
  { speaker: "founder", text: "Hi Dana, it's Jo.", startSec: 0 },
  { speaker: "founder", text: "Is now a bad time?", startSec: 2 },
  { speaker: "prospect", text: "I have two minutes.", startSec: 4 },
  { speaker: "prospect", text: "  ", startSec: 6 },
  { speaker: "founder", text: "I'll send the pilot terms Thursday.", startSec: 8 },
];
const suggestion = {
  outcome: "interested" as const,
  note: "Wants the pilot terms. ",
  commitments: ["Send the pilot terms Thursday"],
};
const row = (over: Partial<CallListRow> = {}): CallListRow => ({
  prospectId: 1,
  name: "Dana Reyes",
  title: "COO",
  company: "Acme Dental",
  phone: "+15125551234",
  queueId: 10,
  local: { zones: ["America/Chicago"], localTime: "10:05", inWindow: true, opensAt: null },
  playName: "post-funding",
  section: "due",
  reason: "replied: interested",
  lastTouchAt: null,
  lastCall: null,
  ...over,
});
const data = (over: Partial<CallListResponse> = {}): CallListResponse => ({
  enabled: true,
  dialMode: "bridge",
  window: { start: "09:00", end: "17:00", weekdays: true },
  due: [row()],
  list: [],
  ...over,
});
const page = (d: CallListResponse, selected = 1) =>
  render(<CallsView data={d} selected={selected} onOpen={() => {}} />);
/** The panel with an unlogged bridged call in the history, as a reload finds it. */
const panelWith = (c: CallRecordView, calls: CallsMeResponse = me()) => {
  client.setQueryData(callsMeKey, calls);
  client.setQueryData(["prospect-calls", 1], { calls: [c] });
  client.setQueryData(callKey(c.id), c);
  return page(data());
};

describe("bridged call logic", () => {
  it("reads live, polls fast while live, slower for the transcript, then stops", () => {
    expect(isLive(call({ status: "ringing_founder" }))).toBe(true);
    expect(isLive(call({ status: "ringing_prospect" }))).toBe(true);
    expect(isLive(call({ status: "ended" }))).toBe(false);
    expect(isLive(undefined)).toBe(false);
    expect(bridgePollMs(undefined)).toBe(LIVE_POLL_MS);
    expect(bridgePollMs(call())).toBe(LIVE_POLL_MS);
    expect(bridgePollMs(call({ status: "ended", transcriptStatus: "pending" }))).toBe(
      TRANSCRIPT_POLL_MS,
    );
    expect(bridgePollMs(call({ status: "ended", transcriptStatus: "ready" }))).toBe(false);
    expect(bridgePollMs(call({ status: "failed" }))).toBe(false);
  });

  it("says where the call is in plain words", () => {
    expect(firstName("Dana Reyes")).toBe("Dana");
    expect(firstName(null)).toBe("them");
    expect(bridgeStatusLine("ringing_founder", "Dana")).toBe("Ringing your phone…");
    expect(bridgeStatusLine("ringing_prospect", "Dana")).toBe("Calling Dana…");
    expect(bridgeStatusLine("connected", "Dana")).toBe("Connected");
    expect(bridgeStatusLine("ended", "Dana")).toBe("Ended");
    expect(bridgeStatusLine(undefined, "Dana")).toBe("Ringing your phone…");
  });

  it("joins a side's sentences into one turn and drops empty ones", () => {
    expect(transcriptTurns(transcript)).toEqual([
      { speaker: "founder", text: "Hi Dana, it's Jo. Is now a bad time?", startSec: 0 },
      { speaker: "prospect", text: "I have two minutes.", startSec: 4 },
      { speaker: "founder", text: "I'll send the pilot terms Thursday.", startSec: 8 },
    ]);
  });

  it("names who called: you, another member's email, or the owner", () => {
    const jo = { email: "jo@oneshot.dev", name: "Jo", role: "member" as const };
    const owner = { email: null, name: null, role: "owner" as const };
    expect(callerLabel("jo@oneshot.dev", jo)).toBe("you");
    expect(callerLabel("sam@oneshot.dev", jo)).toBe("sam@oneshot.dev");
    expect(callerLabel(null, jo)).toBe("the owner");
    expect(callerLabel(null, owner)).toBe("you");
    expect(callerLabel("jo@oneshot.dev", undefined)).toBe("jo@oneshot.dev");
  });

  it("picks up the newest unlogged bridged call from the last few hours", () => {
    const now = NOW.getTime();
    const older = call({ id: 5, startedAt: "2026-11-18T15:00:00Z" });
    const newest = call({ id: 6, startedAt: "2026-11-18T16:00:00Z" });
    expect(resumableCall([older, newest], now)?.id).toBe(6);
    expect(resumableCall([call({ outcome: "no_answer" })], now)).toBeNull();
    expect(resumableCall([call({ provider: "tel" })], now)).toBeNull();
    expect(resumableCall([call({ status: "failed" })], now)).toBeNull();
    expect(resumableCall([call({ startedAt: "2026-11-18T08:00:00Z" })], now)).toBeNull();
    expect(resumableCall(undefined, now)).toBeNull();
  });

  it("fills the suggestion only into a panel the member hasn't touched", () => {
    const blank: DialState = { outcome: null, note: "", holdUntil: "2026-11-25" };
    const pick = suggestedPick(suggestion)!;
    expect(pick).toEqual({ outcome: "interested", note: "Wants the pilot terms." });
    expect(dialReducer(blank, { kind: "suggest", ...pick })).toMatchObject(pick);
    const picked = { ...blank, outcome: "voicemail" as const };
    expect(dialReducer(picked, { kind: "suggest", ...pick })).toBe(picked);
    const typed = { ...blank, note: "call back at 3" };
    expect(dialReducer(typed, { kind: "suggest", ...pick })).toBe(typed);
    expect(suggestedPick(null)).toBeNull();
  });

  it("logs against the bridged call with its id", () => {
    const state: DialState = { outcome: "interested", note: "", holdUntil: "2026-11-25" };
    expect(
      logCallRequest(state, { callId: 7, durationSec: 184, playName: "post-funding" }),
    ).toEqual({ outcome: "interested", callId: 7, durationSec: 184, playName: "post-funding" });
  });
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
describe("bridged call API", () => {
  it("starts, reads and hangs up a call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok(call()));
    await api.startCall({ prospectId: 1, playName: "post-funding" });
    await api.call(7);
    await api.hangUpCall(7);
    const [start, read, hangUp] = fetch.mock.calls;
    expect(start![0]).toBe("/api/calls/start");
    expect(JSON.parse(String(start![1]?.body))).toEqual({
      prospectId: 1,
      playName: "post-funding",
    });
    expect(read![0]).toBe("/api/calls/7");
    expect(hangUp![0]).toBe("/api/calls/7/hangup");
    expect(hangUp![1]?.method).toBe("POST");
  });

  it("a refused start carries the server's plain message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "It's 6:10pm for Dana. Calls open at 9:00." }), {
        status: 409,
        statusText: "Conflict",
      }),
    );
    await expect(api.startCall({ prospectId: 1 })).rejects.toThrow(
      "It's 6:10pm for Dana. Calls open at 9:00.",
    );
  });

  it("verifies, checks and removes the member's phone", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ok(phone({ status: "verifying" })));
    await api.verifyPhone("+15125550100");
    await api.checkPhone();
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.removePhone()).resolves.toBeNull();
    const [verify, check, remove] = fetch.mock.calls;
    expect(verify![0]).toBe("/api/calls/me/phone");
    expect(JSON.parse(String(verify![1]?.body))).toEqual({ phone: "+15125550100" });
    expect(check![0]).toBe("/api/calls/me/phone/check");
    expect(remove![0]).toBe("/api/calls/me/phone");
    expect(remove![1]?.method).toBe("DELETE");
  });
});

describe("Your phone", () => {
  const view = (screen: Parameters<typeof YourPhoneView>[0]["screen"], p = phone()) =>
    render(
      <YourPhoneView
        screen={screen}
        phone={p}
        failure="The code wasn't typed in within two minutes."
        draft=""
        inputError={null}
        busy={false}
        removeError={null}
        canCancel={false}
        onDraft={() => {}}
        onVerify={() => {}}
        onRetry={() => {}}
        onChange={() => {}}
        onCancel={() => {}}
        onRemove={() => {}}
      />,
    );

  it("picks the screen from the server's state", () => {
    const idle = { editing: false, timedOut: false };
    expect(yourPhoneScreen(me({ bridgeReady: false }), idle)).toBe("no_keys");
    expect(yourPhoneScreen(me(), idle)).toBe("enter");
    const verifying = me({ phone: phone({ status: "verifying", validationCode: "123456" }) });
    expect(yourPhoneScreen(verifying, idle)).toBe("verifying");
    expect(yourPhoneScreen(verifying, { editing: false, timedOut: true })).toBe("failed");
    const verified = me({ phone: phone({ status: "verified", phone: "+15125550100" }) });
    expect(yourPhoneScreen(verified, idle)).toBe("verified");
    expect(yourPhoneScreen(verified, { editing: true, timedOut: false })).toBe("enter");
    expect(yourPhoneScreen(me({ phone: phone({ status: "failed" }) }), idle)).toBe("failed");
  });

  it("explains a failure in plain words", () => {
    const verifying = me({ phone: phone({ status: "verifying" }) });
    expect(verifyFailure(verifying, { timedOut: true })).toMatch(/two minutes/);
    const failed = me({ phone: phone({ status: "failed", error: "The call wasn't answered." }) });
    expect(verifyFailure(failed, { timedOut: false })).toBe("The call wasn't answered.");
    expect(verifyFailure(me({ phone: phone({ status: "failed" }) }), { timedOut: false })).toBe(
      "Your phone couldn't be verified.",
    );
  });

  it("checks a typed number loosely; the server normalises it", () => {
    expect(phoneInputError("")).toBe("Type your mobile number.");
    expect(phoneInputError("+1 (512) 555-0100")).toBeNull();
    expect(phoneInputError("call me")).toBe("Only digits, spaces and +.");
    expect(phoneInputError("12345")).toMatch(/doesn't look like/);
  });

  it("checks every 3s until verified, and gives up after two minutes", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const check = vi
      .fn<() => Promise<MemberPhoneView>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(phone({ status: "verifying" }))
      .mockResolvedValue(phone({ status: "verified", phone: "+15125550100" }));
    const onPhone = vi.fn();
    const onTimeout = vi.fn();
    pollVerification(check, { onPhone, onTimeout });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onPhone).not.toHaveBeenCalled(); // a failed check waits for the next tick
    await vi.advanceTimersByTimeAsync(3000);
    expect(onPhone).toHaveBeenLastCalledWith(phone({ status: "verifying" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(onPhone).toHaveBeenLastCalledWith(phone({ status: "verified", phone: "+15125550100" }));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onTimeout).not.toHaveBeenCalled();

    const slow = vi.fn(async () => phone({ status: "verifying" }));
    const late = vi.fn();
    pollVerification(slow, { onPhone: () => {}, onTimeout: late });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(late).toHaveBeenCalledTimes(1);
    expect(slow).toHaveBeenCalledTimes(40);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slow).toHaveBeenCalledTimes(40);
  });

  it("without the call keys, says Call opens the phone app meanwhile", () => {
    const html = view("no_keys");
    expect(html).toContain("needs the call keys");
    expect(html).toContain("Call opens your phone app");
    expect(html).not.toContain("Verify");
  });

  it("asks for the mobile with a Verify button that never submits the section", () => {
    const html = view("enter");
    expect(html).toContain('type="tel"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*> Verify<\/button>/);
    expect(html).toContain("Used in every workspace");
  });

  it("shows the code big while the phone rings", () => {
    const html = view(
      "verifying",
      phone({ status: "verifying", phone: "+15125550100", validationCode: "482913" }),
    );
    expect(html).toContain("Your phone is ringing. Answer and type this code.");
    expect(html).toMatch(/text-\[32px\][^>]*>482913</);
  });

  it("shows the verified number with Change and Remove", () => {
    const html = view("verified", phone({ status: "verified", phone: "+15125550100" }));
    expect(html).toContain("+15125550100");
    expect(html).toContain("Verified");
    expect(html).toContain("Change");
    expect(html).toContain("Remove");
    expect(html).toContain("Used in every workspace");
  });

  it("shows the plain error and Try again when it failed", () => {
    const html = view("failed", phone({ status: "failed", phone: "+15125550100" }));
    expect(html).toContain("The code wasn&#x27;t typed in within two minutes.");
    expect(html).toContain("Try again");
  });

  it("sits in Setup → Calls, read from /api/calls/me", () => {
    client.setQueryData(
      callsMeKey,
      me({ phone: phone({ status: "verified", phone: "+15125550100" }) }),
    );
    const html = render(
      <CallsSection
        calls={{
          enabled: true,
          cadenceStep: null,
          window: { start: "09:00", end: "17:00", weekdays: true },
          bridge: { provider: "twilio", record: true },
        }}
        onDirtyChange={() => {}}
      />,
    );
    expect(html).toContain("Your phone");
    expect(html).toContain("+15125550100");
    expect(html).toContain("Verified");
  });
});

describe("the dial panel in bridge mode", () => {
  it("while connected: the timer, Hang up, the consent line, and Save waits", () => {
    const html = panelWith(call({ status: "connected" }));
    expect(html).toContain("Connected");
    expect(html).toContain('aria-label="call time"');
    expect(html).toContain("Hang up");
    expect(html).toContain(CONSENT_LINE);
    expect(html).toContain("save once the call ends");
    // Call is hidden while one is live.
    expect(html).not.toContain('title="Rings your phone, then theirs"');
  });

  it("names the prospect while their phone rings, and skips the consent line when not recording", () => {
    const html = panelWith(call({ status: "ringing_prospect" }), me({ record: false }));
    expect(html).toContain("Calling Dana…");
    expect(html).not.toContain(CONSENT_LINE);
  });

  it("after it ends: the transcript on its way, and Call again", () => {
    const html = panelWith(
      call({ status: "ended", durationSec: 184, transcriptStatus: "pending" }),
    );
    expect(html).toContain("Ended");
    expect(html).toContain("3:04");
    expect(html).toContain("Transcript on its way");
    expect(html).not.toContain("Hang up");
    expect(html).toContain('title="Rings your phone, then theirs"');
  });

  it("shows the transcript as You and Them, and the suggestion clearly marked", () => {
    const html = panelWith(
      call({ status: "ended", transcriptStatus: "ready", transcript, suggestion }),
    );
    expect(html).toContain(">You</dt>");
    expect(html).toContain(">Them</dt>");
    expect(html).toContain("I have two minutes.");
    expect(html).toContain("Suggested:</span> Interested");
    expect(html).toContain("Send the pilot terms Thursday");
  });

  it("privacy mode hides the transcript and what the suggestion says", () => {
    privacy.masked = true;
    const html = panelWith(
      call({ status: "ended", transcriptStatus: "ready", transcript, suggestion }),
    );
    expect(html).not.toContain("I have two minutes.");
    expect(html).not.toContain("Send the pilot terms Thursday");
    expect(html).toContain("Hidden while privacy mode is on.");
  });

  it("says when the transcript didn't come through", () => {
    const html = panelWith(call({ status: "ended", transcriptStatus: "failed" }));
    expect(html).toContain("The transcript didn&#x27;t come through.");
  });

  it("in tel: mode, points a member with an unverified phone to Setup", () => {
    client.setQueryData(callsMeKey, me());
    const html = page(data({ dialMode: "tel" }));
    expect(html).toContain('href="tel:+15125551234"');
    expect(html).toContain("verify it in");
    expect(html).toContain('href="/setup#calls"');
    client.setQueryData(callsMeKey, me({ bridgeReady: false }));
    expect(page(data({ dialMode: "tel" }))).not.toContain("verify it in");
  });

  it("BridgeCallView shows the plain line while your own phone rings", () => {
    const html = render(
      <BridgeCallView
        call={call({ status: "ringing_founder" })}
        first="Dana"
        record
        connectedSec={0}
        hangingUp={false}
        onHangUp={() => {}}
        pollError={null}
        masked={false}
      />,
    );
    expect(html).toContain("Ringing your phone…");
    expect(html).toContain("Hang up");
  });
});

describe("call history", () => {
  const jo = { email: "jo@oneshot.dev", name: "Jo", role: "member" as const };
  const history = (calls: CallRecordView[], masked = false) =>
    render(
      <CallHistory
        calls={calls}
        isLoading={false}
        error={null}
        onRetry={() => {}}
        masked={masked}
        me={jo}
      />,
    );
  const logged = call({
    status: "ended",
    outcome: "interested",
    durationSec: 184,
    transcriptStatus: "ready",
    transcript,
  });

  it("says who called and folds the transcript away", () => {
    const html = history([
      logged,
      call({ id: 8, member: "sam@oneshot.dev", outcome: "no_answer", provider: "tel" }),
      call({ id: 9, member: null, status: "ended" }),
    ]);
    expect(html).toContain("by you");
    expect(html).toContain("by sam@oneshot.dev");
    expect(html).toContain("by the owner");
    expect(html).toContain("Not logged yet");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Transcript<\/summary>/);
    expect(html).toContain("I have two minutes.");
  });

  it("privacy mode masks the caller's email and hides the transcript", () => {
    privacy.masked = true;
    const html = history(
      [logged, call({ id: 8, member: "sam@oneshot.dev", outcome: "no_answer" })],
      true,
    );
    expect(html).not.toContain("sam@oneshot.dev");
    expect(html).toContain("sam•••@oneshot.dev");
    expect(html).not.toContain("I have two minutes.");
    expect(html).toContain("transcript hidden");
  });

  it("an empty recording says so", () => {
    expect(render(<TranscriptView transcript={[]} />)).toContain("Nothing was said");
  });
});
