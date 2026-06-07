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
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: {} }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
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
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT DATE: tomorrow \(/);
  });

  it("humanizes 7-13 day event date to 'next <weekday>'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(10) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT DATE: next \w+ \(/);
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
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT DATE: today \(/);
  });

  it("humanizes 2-6 day events to 'this <weekday>'", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(4) }],
    });
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT DATE: this \w+ \(/);
  });

  it("humanizes 14+ day events to a short date format", async () => {
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: inFutureDays(30) }],
    });
    // Format: "Sat, Jul 4" — short weekday + comma + month + day (locale-dependent).
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT DATE: \w{3},? \w{3} \d{1,2} \(/);
  });

  it("humanizes a past date to the bare ISO-date (10 chars)", async () => {
    const pastIso = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    await runLumaEvents({
      dryRun: true,
      targets: [{ ...base, eventDate: pastIso }],
    });
    // Format: "YYYY-MM-DD ("
    expect(calls.llmInputBlocks[0]).toMatch(/EVENT DATE: \d{4}-\d{2}-\d{2} \(/);
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
