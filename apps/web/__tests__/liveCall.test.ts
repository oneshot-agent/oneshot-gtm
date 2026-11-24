import { describe, expect, it } from "vitest";
import type { CallRecordView, LiveCallView, LiveCallsResponse } from "@oneshot-gtm/shared-types";
import {
  elapsedSec,
  liveCallFor,
  liveCallLine,
  liveCallsPollMs,
  memberLabel,
  recordingState,
  rowLiveLine,
  callBlock,
} from "../src/lib/liveCall.ts";

// The live call bar's wording: where each call is, whether it is recorded,
// and how often the bar reads.

const NOW = Date.parse("2026-11-24T16:05:00Z");
const live = (over: Partial<LiveCallView> = {}): LiveCallView => ({
  id: 7,
  prospectId: 1,
  playName: null,
  member: "mia@acme.com",
  startedAt: "2026-11-24T16:00:00Z",
  durationSec: null,
  outcome: null,
  note: null,
  provider: "twilio",
  status: "connected",
  connectedAt: "2026-11-24T16:02:50Z",
  transcriptStatus: "none",
  suggestion: null,
  prospectName: "Dana Reyes",
  prospectCompany: "Acme Dental",
  mine: true,
  ...over,
});
type Rec = Pick<
  CallRecordView,
  "status" | "transcriptStatus" | "recordedFrom" | "discard" | "recordingPaused"
>;
const rec = (over: Partial<Rec> = {}): Rec => ({
  status: "connected",
  transcriptStatus: "none",
  ...over,
});

describe("recordingState", () => {
  it("while live: recording, deleted, or what it waits on in each mode", () => {
    expect(recordingState(rec({ transcriptStatus: "pending" }), "ask")).toEqual({
      label: "● Recording",
      tone: "recording",
    });
    expect(
      recordingState(rec({ transcriptStatus: "pending", recordedFrom: "answer" }), false).label,
    ).toBe("● Recording");
    expect(recordingState(rec({ discard: "pending" }), "always").label).toBe("Deleting recording…");
    expect(recordingState(rec({ discard: "done" }), "always").label).toBe("Recording deleted");
    expect(
      recordingState(rec({ transcriptStatus: "pending", recordingPaused: true }), "always"),
    ).toEqual({ label: "Recording stopped", tone: "muted" });
    expect(recordingState(rec(), "ask")).toEqual({
      label: "Not recording · ask first",
      tone: "warn",
    });
    expect(recordingState(rec(), false).label).toBe("Not recorded · recording is off");
    expect(recordingState(rec({ status: "ringing_prospect" }), "always").label).toBe(
      "Records when they answer",
    );
    expect(recordingState(rec({ status: "ringing_founder" }), "ask").label).toBe(
      "Not recording · ask first",
    );
  });

  it("after it ends or fails: where the transcript is", () => {
    for (const status of ["ended", "failed"] as const) {
      expect(recordingState(rec({ status, transcriptStatus: "pending" }), "always").label).toBe(
        "Transcribing…",
      );
      expect(recordingState(rec({ status, transcriptStatus: "ready" }), "always")).toEqual({
        label: "Transcript ready",
        tone: "ok",
      });
      expect(recordingState(rec({ status, transcriptStatus: "failed" }), "ask")).toEqual({
        label: "Transcript failed",
        tone: "warn",
      });
      expect(recordingState(rec({ status }), false).label).toBe("No transcript · not recorded");
      expect(recordingState(rec({ status, discard: "done" }), "always").label).toBe(
        "Recording deleted",
      );
    }
  });
});

describe("liveCallLine", () => {
  it("says where the call is, naming the prospect", () => {
    expect(liveCallLine({ status: "ringing_founder" }, "Dana")).toBe("Ringing you…");
    expect(liveCallLine({ status: "ringing_founder", mine: false }, "Dana")).toBe(
      "Ringing their phone…",
    );
    expect(liveCallLine({ status: "ringing_prospect" }, "Dana")).toBe("Ringing Dana…");
    expect(liveCallLine({ status: "connected" }, "Dana Reyes")).toBe("On a call with Dana Reyes");
    expect(liveCallLine({ status: "ended" }, "Dana")).toBe("Call with Dana ended");
    expect(liveCallLine({ status: "connected" }, null)).toBe("On a call with them");
  });

  it("a failed call gives the server's reason", () => {
    expect(
      liveCallLine({ status: "failed", statusReason: "it went to your voicemail" }, "Dana"),
    ).toBe("The call didn't go through: it went to your voicemail");
    expect(liveCallLine({ status: "failed" }, "Dana")).toBe("The call didn't go through");
  });
});

describe("elapsedSec", () => {
  it("counts from the server's connect time, only while connected", () => {
    expect(elapsedSec(live(), NOW)).toBe(130);
    expect(elapsedSec(live({ status: "ended" }), NOW)).toBeNull();
    expect(elapsedSec(live({ status: "ringing_prospect" }), NOW)).toBeNull();
    expect(elapsedSec(live({ connectedAt: undefined }), NOW)).toBeNull();
    expect(elapsedSec(live({ connectedAt: "garbage" }), NOW)).toBeNull();
    expect(elapsedSec(live({ connectedAt: "2026-11-24T16:06:00Z" }), NOW)).toBe(0);
  });
});

const res = (calls: LiveCallView[], enabled = true): LiveCallsResponse => ({
  enabled,
  record: "ask",
  calls,
});

describe("liveCallsPollMs", () => {
  it("polls fast for your own live call, slower for a teammate's, slowly otherwise", () => {
    expect(liveCallsPollMs(res([live()]))).toBe(2_000);
    expect(liveCallsPollMs(res([live({ mine: false })]))).toBe(5_000);
    expect(liveCallsPollMs(res([live({ status: "ended" })]))).toBe(20_000);
    expect(liveCallsPollMs(res([]))).toBe(20_000);
    expect(liveCallsPollMs(undefined)).toBe(20_000);
    expect(liveCallsPollMs(res([live()], false))).toBe(60_000);
  });
});

describe("who is on a call", () => {
  it("names a teammate by their email's name part, never in privacy mode", () => {
    expect(memberLabel("mia@acme.com", false)).toBe("Mia");
    expect(memberLabel(null, false)).toBe("the owner");
    expect(memberLabel("mia@acme.com", true)).toBe("teammate");
  });

  it("finds this prospect's live call, yours first, and ignores ended ones", () => {
    const theirs = live({ id: 1, mine: false });
    const mine = live({ id: 2 });
    expect(liveCallFor([theirs, mine], 1)?.id).toBe(2);
    expect(liveCallFor([theirs], 1)?.id).toBe(1);
    expect(liveCallFor([live({ status: "ended" })], 1)).toBeNull();
    expect(liveCallFor([mine], 2)).toBeNull();
    expect(liveCallFor(undefined, 1)).toBeNull();
  });

  it("holds Call as the server would refuse it", () => {
    const theirs = live({ mine: false });
    expect(callBlock([theirs], 1, false)).toBe("Mia is on a call with them");
    expect(callBlock([theirs], 1, true)).toBe("a teammate is on a call with them");
    expect(callBlock([live()], 1, false)).toBe("you're on a call with them");
    expect(callBlock([live()], 2, false)).toBe("hang up your other call first");
    expect(callBlock([live({ status: "ended" })], 2, false)).toBeNull();
    expect(callBlock([live({ mine: false, status: "ended" })], 1, false)).toBeNull();
    expect(callBlock([theirs], 2, false)).toBeNull();
  });

  it("gives the Calls row a short line with the timer", () => {
    expect(rowLiveLine(live({ mine: false }), false, NOW)).toBe("Mia on a call · 2:10");
    expect(rowLiveLine(live({ mine: false }), true, NOW)).toBe("teammate on a call · 2:10");
    expect(rowLiveLine(live({ status: "ringing_prospect" }), false, NOW)).toBe("you're calling");
  });
});
