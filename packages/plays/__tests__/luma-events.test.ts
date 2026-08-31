import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies the luma-events play drafts a forward-looking pitch: the inputBlock
// carries EVENT TITLE / EVENT CITY / EVENT DATE / EVENT URL / YOUR EDGE, and
// it's one-touch (no cadence enroll).

const calls = { llmInputBlocks: [] as string[], enrolled: 0 };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "thing",
      productDomain: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      // Pin the install fallback zone so the date assertions below don't depend
      // on whatever TZ the machine running the suite happens to be in.
      timezone: "America/New_York",
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: {} }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => null,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      enrollCadence: () => {
        calls.enrolled++;
      },
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.llmInputBlocks.push(input.messages.find((m) => m.role === "user")?.content ?? "");
      return { content: JSON.stringify({ subject: "s", body: "b" }), provider: "t", model: "t" };
    },
  };
});

const { runLumaEvents } = await import("../src/luma-events.ts");

const base = {
  name: "Ada",
  email: "ada@acme.dev",
  company: "Acme",
  eventTitle: "SF AI Builders Meetup",
  eventCity: "San Francisco",
  eventUrl: "https://luma.com/abc123",
  yourEdge: "a 30-second teardown of how X handles Y",
} as const;

function inFutureDays(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

function inPastDays(days: number): string {
  return inFutureDays(-days);
}

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runLumaEvents", () => {
  it("includes EVENT lines + YOUR EDGE in the input block", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(7) }],
    });
    const block = calls.llmInputBlocks[0]!;
    expect(block).toContain("EVENT TITLE: SF AI Builders Meetup");
    expect(block).toContain("EVENT CITY: San Francisco");
    expect(block).toContain("EVENT URL: https://luma.com/abc123");
    expect(block).toContain("YOUR EDGE: a 30-second teardown of how X handles Y");
  });

  it("humanizes near-future event date to 'tomorrow'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(1) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: tomorrow\n/);
  });

  it("humanizes 7-13 day event date to 'next <weekday>'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(10) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: next \w+\n/);
  });

  it("surfaces EVENT ABOUT when eventDescription is set", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [
        { ...base, eventDate: inFutureDays(7), eventDescription: "A deep dive on eval harnesses" },
      ],
    });
    expect(calls.llmInputBlocks[0]).toContain("EVENT ABOUT: A deep dive on eval harnesses");
  });

  it("falls back to 'EVENT ABOUT: (none)' when eventDescription is unset", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(7) }],
    });
    expect(calls.llmInputBlocks[0]).toContain("EVENT ABOUT: (none)");
  });

  it("surfaces attendeeBio when set", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(3), attendeeBio: "Founder @ AcmeAI" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("ATTENDEE BIO/ROLE: Founder @ AcmeAI");
  });

  it("is one-touch: never enrolls a cadence on send", async () => {
    const out = await runLumaEvents({
      dryRun: false,
      targets: [{ ...base, eventDate: inFutureDays(5) }],
    });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(0);
  });

  it("humanizes 0-day events to 'today'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: new Date().toISOString() }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: today\n/);
  });

  it("humanizes 2-6 day events to 'this <weekday>'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(4) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: this \w+\n/);
  });

  it("humanizes 14+ day events to a short date format", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(30) }],
    });
    // Format: "Sat, Jul 4" — short weekday + comma + month + day (locale-dependent).
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: \w{3},? \w{3} \d{1,2}\n/);
  });

  it("humanizes a recently-passed date to 'last <weekday>'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inPastDays(5) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: last \w+\n/);
  });

  it("humanizes yesterday's event to 'yesterday'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inPastDays(1) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT WHEN: yesterday\n/);
  });

  it("marks upcoming events EVENT TIMING: UPCOMING", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(7) }],
    });
    expect(calls.llmInputBlocks[0]).toContain("EVENT TIMING: UPCOMING");
  });

  it("marks passed events EVENT TIMING: PAST (retrospective)", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inPastDays(4) }],
    });
    expect(calls.llmInputBlocks[0]).toContain("EVENT TIMING: PAST");
  });

  it("holds stale (>14d past) events with a stale-event flag instead of sending", async () => {
    const out = await runLumaEvents({
      dryRun: false,
      targets: [{ ...base, eventDate: inPastDays(30) }],
    });
    expect(out.drafted[0]?.flags).toContain("stale-event");
    expect(out.drafted[0]?.sent).toBe(false);
  });

  it("omits 'at <company>' from the PROSPECT line when company is unset", async () => {
    const { company: _ignored, ...noCompanyBase } = base;
    void _ignored;
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...noCompanyBase, eventDate: inFutureDays(7) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/PROSPECT: Ada\n/);
  });

  it("falls back to '(none)' for attendeeBio when not provided", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(7) }],
    });
    expect(calls.llmInputBlocks[0]).toContain("ATTENDEE BIO/ROLE: (none)");
  });
});

// A 7:30pm Wednesday event in San Francisco IS the instant 2026-08-27T02:30:00Z.
// Handed that instant, the model reads "27" and writes "Thursday" into a cold
// email about the reader's own event — a factual error the prospect notices and
// one we can't take back. So the play must hand the prompt a pre-resolved local
// string and no instant at all.
describe("runLumaEvents event dates reach the prompt already localized", () => {
  const SF_EVENING = "2026-08-27T02:30:00Z";
  /** ISO-8601 with an explicit UTC `Z` or a numeric offset — what must NOT leak. */
  const ISO_INSTANT = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})/;

  beforeEach(() => {
    // Fake only Date: the play's relative phrasing ("this Wednesday") and its
    // staleness hold are both read off "now", and real timers would make these
    // cases rot. Two days before the event, in the event's own zone.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-24T19:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("names the event's own weekday, not the UTC one", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: SF_EVENING, eventTimezone: "America/Los_Angeles" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("EVENT DATE: Wednesday, August 26, 7:30 PM PDT");
    expect(calls.llmInputBlocks[0]).not.toContain("Thursday");
  });

  it("derives the zone from the event's city when the page stated none", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: SF_EVENING, eventCity: "San Francisco" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("EVENT DATE: Wednesday, August 26, 7:30 PM PDT");
  });

  it("prefers the finder's pre-rendered string over re-formatting here", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [
        {
          ...base,
          eventDate: SF_EVENING,
          eventTimezone: "America/Los_Angeles",
          eventDateLocal: "Wednesday, August 26, 7:30 PM PDT (doors 7:00)",
        },
      ],
    });
    expect(calls.llmInputBlocks[0]).toContain(
      "EVENT DATE: Wednesday, August 26, 7:30 PM PDT (doors 7:00)",
    );
  });

  it("falls back to the install timezone when neither zone nor city places it", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: SF_EVENING, eventCity: "Online" }],
    });
    // Mocked config pins the install zone to America/New_York.
    expect(calls.llmInputBlocks[0]).toContain("EVENT DATE: Wednesday, August 26, 10:30 PM EDT");
  });

  it("anchors TODAY in the same zone and binds the model with a DATE NOTE", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: SF_EVENING, eventTimezone: "America/Los_Angeles" }],
    });
    const block = calls.llmInputBlocks[0]!;
    expect(block).toContain("TODAY: Monday, August 24, 2026");
    expect(block).toContain("EVENT WHEN: this Wednesday");
    expect(block).toMatch(/DATE NOTE: .*ALREADY in the event's local time/);
    expect(block).toMatch(/DATE NOTE: .*never convert them to another timezone/);
  });

  it("puts NO ISO-8601 Z/offset timestamp in the prompt for an event-bearing candidate", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [
        {
          ...base,
          eventDate: SF_EVENING,
          eventTimezone: "America/Los_Angeles",
          eventDescription: "A deep dive on eval harnesses",
          attendeeBio: "Founder @ AcmeAI",
        },
      ],
    });
    expect(calls.llmInputBlocks[0]).not.toMatch(ISO_INSTANT);
    expect(calls.llmInputBlocks[0]).not.toContain(SF_EVENING);
  });

  it("leaks no instant for a passed event either", async () => {
    vi.setSystemTime(new Date("2026-08-30T19:00:00Z"));
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: SF_EVENING, eventTimezone: "America/Los_Angeles" }],
    });
    const block = calls.llmInputBlocks[0]!;
    expect(block).not.toMatch(ISO_INSTANT);
    expect(block).toContain("EVENT TIMING: PAST");
    expect(block).toContain("EVENT DATE: Wednesday, August 26, 7:30 PM PDT");
  });

  it("classifies staleness on the event's local day, not the UTC one", async () => {
    // 15 local days past the event in LA -> held. The instant's UTC date is a
    // day later, which is exactly the sort of off-by-one this guards.
    vi.setSystemTime(new Date("2026-09-10T19:00:00Z"));
    const out = await runLumaEvents({
      dryRun: false,
      targets: [{ ...base, eventDate: SF_EVENING, eventTimezone: "America/Los_Angeles" }],
    });
    expect(out.drafted[0]?.flags).toContain("stale-event");
    expect(out.drafted[0]?.sent).toBe(false);
  });

  it("still drafts, without an instant, when the date won't parse at all", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: "sometime in the fall" }],
    });
    const block = calls.llmInputBlocks[0]!;
    expect(block).toContain("EVENT DATE: sometime in the fall");
    expect(block).not.toMatch(ISO_INSTANT);
  });
});
