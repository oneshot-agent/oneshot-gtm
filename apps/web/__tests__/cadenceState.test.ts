import type { CadenceView } from "@oneshot-gtm/shared-types";
import { describe, expect, it } from "vitest";
import { cadenceStateLabel, mailWaitingRows } from "../src/lib/cadenceState.ts";

// Issue #602: the /cadences row's second line is the sequence state, in one
// mono label. Every branch, against a fixed clock.

const now = new Date("2026-09-10T12:00:00Z");
const daysAgo = (d: number): string => new Date(now.getTime() - d * 86_400_000).toISOString();
const daysAhead = (d: number): string => new Date(now.getTime() + d * 86_400_000).toISOString();

function cadence(over: Partial<CadenceView> = {}): CadenceView {
  return {
    prospectId: 1,
    prospectEmail: "a@x.io",
    prospectName: "Ada",
    prospectCompany: "Acme",
    prospectTitle: "CTO",
    prospectLinkedinUrl: null,
    playName: "show-hn",
    status: "active",
    currentStep: 1,
    enrolledAt: daysAgo(10),
    nextDueAt: daysAhead(1),
    lastPolledAt: null,
    stopReason: null,
    stopNote: null,
    stoppedAt: null,
    replyChannel: null,
    replyAt: null,
    nextStepDraft: null,
    nextStepLabel: "value follow-up",
    nextStepIsBreakup: false,
    followupCount: 3,
    priorSteps: [{ stepIndex: 0, label: "intro", subject: "hi", body: null, sentAt: daysAgo(3) }],
    isSending: false,
    lastSendError: null,
    lastSendErrorAt: null,
    queuePayload: null,
    ...over,
  };
}

describe("cadenceStateLabel", () => {
  it("active: step, last send, next due", () => {
    expect(cadenceStateLabel(cadence(), now)).toEqual({
      text: "step 2 of 4 · sent 3d ago · next in 1d",
      tone: "muted",
    });
  });

  it("active and overdue reads in spend", () => {
    expect(cadenceStateLabel(cadence({ nextDueAt: daysAgo(2) }), now)).toEqual({
      text: "step 2 of 4 · sent 3d ago · overdue · due 2d ago",
      tone: "spend",
    });
  });

  it("active with nothing scheduled and nothing left says so; freshly enrolled shows enrolment", () => {
    expect(
      cadenceStateLabel(cadence({ nextDueAt: null, nextStepLabel: null, priorSteps: [] }), now)
        .text,
    ).toBe("step 2 of 4 · enrolled 10d ago · no steps left");
  });

  it("a send failure wins the tone", () => {
    expect(cadenceStateLabel(cadence({ lastSendError: "boom" }), now)).toEqual({
      text: "step 2 of 4 · sent 3d ago · next in 1d · send failed",
      tone: "blocked",
    });
  });

  it("sending in flight", () => {
    expect(cadenceStateLabel(cadence({ isSending: true }), now)).toEqual({
      text: "step 2 of 4 · sending…",
      tone: "receipt",
    });
  });

  it("replied, with the channel and when", () => {
    expect(
      cadenceStateLabel(
        cadence({ status: "replied", replyChannel: "linkedin", replyAt: daysAgo(2) }),
        now,
      ),
    ).toEqual({ text: "replied on linkedin · 2d ago", tone: "receipt" });
    expect(cadenceStateLabel(cadence({ status: "replied" }), now).text).toBe("replied");
  });

  it("stopped, with the reason in words", () => {
    expect(
      cadenceStateLabel(
        cadence({ status: "stopped", stopReason: "not_a_fit", stoppedAt: daysAgo(5) }),
        now,
      ),
    ).toEqual({ text: "stopped · not a fit · 5d ago", tone: "blocked" });
  });

  it("bounced, breakup, completed, paused", () => {
    expect(cadenceStateLabel(cadence({ status: "bounced" }), now)).toEqual({
      text: "bounced · 3d ago",
      tone: "blocked",
    });
    expect(cadenceStateLabel(cadence({ status: "breakup" }), now)).toEqual({
      text: "breakup sent · 3d ago",
      tone: "spend",
    });
    expect(cadenceStateLabel(cadence({ status: "completed", currentStep: 3 }), now)).toEqual({
      text: "completed · 4 of 4 · 3d ago",
      tone: "muted",
    });
    expect(cadenceStateLabel(cadence({ status: "paused" }), now)).toEqual({
      text: "paused · step 2 of 4",
      tone: "muted",
    });
  });
});

describe("a skipped letter (#611)", () => {
  it("does not count as the last send", () => {
    const c = cadence({
      priorSteps: [
        { stepIndex: 0, label: "intro", subject: "hi", body: null, sentAt: daysAgo(3) },
        {
          stepIndex: 1,
          label: "letter skipped",
          subject: "",
          body: null,
          sentAt: daysAgo(1),
          status: "skipped",
        },
      ],
      currentStep: 2,
    });
    expect(cadenceStateLabel(c, now).text).toBe("step 3 of 4 · sent 3d ago · next in 1d");
  });
});

describe("mailWaitingRows", () => {
  it("is the active rows whose next step goes by post and nothing in flight", () => {
    const rows = [
      cadence({ prospectId: 1, nextStepChannel: "direct_mail" }),
      cadence({ prospectId: 2, nextStepChannel: "direct_mail", isSending: true }),
      cadence({ prospectId: 3, nextStepChannel: "direct_mail", status: "stopped" }),
      cadence({ prospectId: 4, nextStepChannel: "email" }),
      cadence({ prospectId: 5 }),
    ];
    expect(mailWaitingRows(rows).map((c) => c.prospectId)).toEqual([1]);
  });
});
