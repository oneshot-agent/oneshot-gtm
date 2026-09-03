import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for runCivicAgendaFinder — mocks the Legistar HTTP
// boundary (via _civic-legistar.ts) and the ICP filter / ledger. Verifies the
// free keyword gate runs BEFORE the paid icpFilter call, and that a body with
// no published contact drops (not a retry) while a fetch failure on the
// contact lookup persists for retry.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}

const enqueued: EnqueuedRow[] = [];
const pendingPersisted: Array<{
  playName: string;
  dedupeKey: string;
  source: string;
  raw: unknown;
}> = [];
let icpMatch: boolean | null = true;
let icpCalls = 0;
let eventsBySlug: Record<string, Array<Record<string, unknown>>> = {};
let itemsByEventId: Record<number, Array<Record<string, unknown>>> = {};
let contactByBodyId: Record<
  number,
  { fullName: string; email: string; phone: string | null; title: string | null } | null | "throw"
> = {};

vi.mock("../src/_pending.ts", () => ({
  persistPending: (input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }) => {
    pendingPersisted.push(input);
  },
  registerPendingRetry: () => {},
}));

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async (input: { candidate: { title: string } }) => {
    icpCalls++;
    return { match: icpMatch, reason: icpMatch ? `fits: ${input.candidate.title}` : "nope" };
  },
}));

vi.mock("../src/_civic-legistar.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_civic-legistar.ts")>(
    "../src/_civic-legistar.ts",
  );
  return {
    ...actual,
    cityToLegistarSlug: (city: string) =>
      ({ "new york": "nyc", chicago: "chicago" })[city.trim().toLowerCase()] ?? null,
    fetchCityEvents: async (slug: string) => eventsBySlug[slug] ?? null,
    fetchEventItems: async (_slug: string, eventId: number) => itemsByEventId[eventId] ?? null,
    fetchBodyContact: async (_slug: string, bodyId: number) => {
      const entry = contactByBodyId[bodyId];
      if (entry === "throw") throw new Error("network down");
      return entry ?? null;
    },
  };
});

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      isQueueDuplicate: () => false,
      isPendingResolution: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runCivicAgendaFinder } = await import("../src/civic-agenda.ts");

beforeEach(() => {
  enqueued.length = 0;
  pendingPersisted.length = 0;
  icpMatch = true;
  icpCalls = 0;
  eventsBySlug = {
    nyc: [
      {
        eventId: 1,
        eventBodyId: 10,
        eventBodyName: "CITY COUNCIL",
        eventDateIso: "2026-09-10T00:00:00",
        eventTime: "10:00 AM",
        eventLocation: "City Hall",
        eventAgendaFile: null,
        eventInSiteUrl: "https://nyc.legistar.com/MeetingDetail.aspx?ID=1",
      },
    ],
  };
  itemsByEventId = {
    1: [
      { eventItemId: 100, title: "Resolution on AI use in permitting", matterFile: "R-1" },
      { eventItemId: 101, title: "Appointment of a new librarian", matterFile: null },
    ],
  };
  contactByBodyId = {
    10: {
      fullName: "Alex Chen",
      email: "alex.chen@council.nyc.gov",
      phone: "555-0100",
      title: "Chief of Staff",
    },
  };
});

afterEach(() => vi.clearAllMocks());

const baseConfig = {
  dryRun: false,
  cities: ["New York"],
  keywords: ["AI", "automation"],
  yourEdge: "a free 30-day pilot",
  sinceDays: 30,
  limit: 25,
};

describe("runCivicAgendaFinder — happy path", () => {
  it("keyword-gates titles before any paid call, then enqueues the surviving item with city/title/date", async () => {
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.candidates).toBe(2); // both agenda items counted
    // Only the AI-matching item reaches icpFilter — the librarian item never does.
    expect(icpCalls).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("civic-pilot");
    expect(row.payload["city"]).toBe("New York");
    expect(row.payload["agendaItemTitle"]).toBe("Resolution on AI use in permitting");
    expect(row.payload["meetingDate"]).toBe("2026-09-10");
    expect(row.payload["email"]).toBe("alex.chen@council.nyc.gov");
    expect(row.payload["name"]).toBe("Alex Chen");
  });

  it("drops (does not persist) an item whose body publishes no member email", async () => {
    contactByBodyId[10] = null;
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(pendingPersisted).toHaveLength(0);
  });

  it("persists for retry when the contact lookup hits a transient error", async () => {
    contactByBodyId[10] = "throw";
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(pendingPersisted).toHaveLength(1);
    expect(pendingPersisted[0]!.playName).toBe("civic-agenda");
  });

  it("skips an unmapped city without failing the whole run", async () => {
    eventsBySlug["chicago"] = [
      {
        eventId: 2,
        eventBodyId: 20,
        eventBodyName: "COMMITTEE",
        eventDateIso: "2026-09-11T00:00:00",
        eventTime: null,
        eventLocation: null,
        eventAgendaFile: null,
        eventInSiteUrl: null,
      },
    ];
    itemsByEventId[2] = [{ eventItemId: 200, title: "AI automation study", matterFile: null }];
    contactByBodyId[20] = {
      fullName: "Sam Lee",
      email: "sam.lee@chicago.gov",
      phone: null,
      title: null,
    };
    const out = await runCivicAgendaFinder({
      ...baseConfig,
      cities: ["New York", "Reykjavik", "Chicago"],
    });
    expect(out.enqueued).toBe(2);
  });

  it("rejects and auto-persists an off-ICP item after the keyword gate passed it", async () => {
    icpMatch = false;
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedIcp).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.initialStatus).toBe("rejected");
  });

  it("drops without persisting on a transient ICP classifier failure", async () => {
    icpMatch = null;
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(0);
  });
});

describe("runCivicAgendaFinder — readiness / halts", () => {
  it("halts when cities is empty", async () => {
    const out = await runCivicAgendaFinder({ ...baseConfig, cities: [] });
    expect(out.halted).toMatch(/cities/);
  });

  it("halts when keywords is empty", async () => {
    const out = await runCivicAgendaFinder({ ...baseConfig, keywords: [] });
    expect(out.halted).toMatch(/keywords/);
  });

  it("halts when every mapped city fails to fetch", async () => {
    eventsBySlug = {};
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.halted).toMatch(/Legistar fetch failed/);
  });
});

describe("runCivicAgendaFinder — dry run", () => {
  it("counts ICP-passers without enqueuing or looking up a contact", async () => {
    const out = await runCivicAgendaFinder({ ...baseConfig, dryRun: true });
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(0);
  });
});
