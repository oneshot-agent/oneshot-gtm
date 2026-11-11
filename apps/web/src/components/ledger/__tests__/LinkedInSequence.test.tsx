import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CadenceSequenceView } from "@oneshot-gtm/shared-types";
import { LinkedInThread, WaitingLetter } from "../LinkedInSequence.tsx";

// A LinkedIn cadence waiting on its invite shows the note that went and the
// messages that follow, never a draft to generate.

const view: CadenceSequenceView = {
  linkedInSent: [
    {
      stepIndex: 3,
      label: "connection request",
      text: "Hey Chandrika, in YC F26 with Quivly.",
      sentAt: "2026-10-27T03:43:21.000Z",
    },
  ],
  invite: { sentOn: "2026-10-27", expiresOn: "2026-11-17" },
  upcoming: [
    {
      stepIndex: 4,
      label: "first LinkedIn message",
      channel: "linkedin",
      isBreakup: false,
      dayOffset: 2,
      awaitsAcceptance: true,
      text: "Hi Chandrika, thanks for connecting.",
    },
    {
      stepIndex: 5,
      label: "LinkedIn breakup",
      channel: "linkedin",
      isBreakup: true,
      dayOffset: 6,
      awaitsAcceptance: false,
      text: null,
    },
  ],
};

const NOW = Date.parse("2026-11-11T22:00:00Z");

describe("WaitingLetter", () => {
  it("shows the note sent, the wait and its end, and every message that follows", () => {
    const html = renderToStaticMarkup(
      <WaitingLetter
        view={view}
        waitingSince="2026-10-27"
        actions={<button>Stop</button>}
        now={NOW}
      />,
    );
    expect(html).toContain("Sent 2026-10-27");
    expect(html).toContain("Connection request");
    expect(html).toContain("Hey Chandrika, in YC F26 with Quivly.");
    expect(html).toContain(
      "waiting for acceptance · 15 days · withdrawn 2026-11-17 if not accepted",
    );
    expect(html).toContain("If no reply");
    expect(html).toContain("step 4 · first LinkedIn message · once they accept");
    expect(html).toContain("Hi Chandrika, thanks for connecting.");
    expect(html).toContain("step 5 · LinkedIn breakup · 6 days later");
    expect(html).toContain("written when it&#x27;s due");
    expect(html).toContain("Stop");
    expect(html).not.toContain("draft");
  });

  it("says what it waits on before the sequence loads, and when it can't be read", () => {
    const loading = renderToStaticMarkup(
      <WaitingLetter view={undefined} waitingSince="2026-10-27" />,
    );
    expect(loading).toContain("Loading what was sent…");
    const failed = renderToStaticMarkup(
      <WaitingLetter view={null} waitingSince="2026-10-27" onRetry={() => {}} />,
    );
    expect(failed).toContain("Waiting for acceptance · invite sent 2026-10-27.");
    expect(failed).toContain("Couldn&#x27;t load what was sent.");
    expect(failed).toContain("Retry");
  });
});

describe("LinkedInThread", () => {
  it("says so, with a retry, when the thread can't be read", () => {
    const html = renderToStaticMarkup(
      <LinkedInThread view={null} nextStep={4} onRetry={() => {}} />,
    );
    expect(html).toContain("Couldn&#x27;t load the LinkedIn thread.");
    expect(html).toContain("Retry");
  });

  it("under a drafted message: what was sent there, and only the steps after the draft", () => {
    const html = renderToStaticMarkup(<LinkedInThread view={view} nextStep={4} />);
    expect(html).toContain("Sent on LinkedIn");
    expect(html).toContain("Hey Chandrika, in YC F26 with Quivly.");
    expect(html).not.toContain("first LinkedIn message");
    expect(html).toContain("step 5 · LinkedIn breakup");
  });
});
