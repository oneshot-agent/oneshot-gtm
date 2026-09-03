import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for runCivicAgendaFinder — mocks the Legistar HTTP
// boundary (via _civic-legistar.ts) and the ICP filter / ledger. Verifies the
// free keyword gate runs BEFORE the paid icpFilter call, and that a body with
// no published contact drops (not a retry) while a fetch failure on the
// contact lookup persists for retry.
//
// fetchCityEvents / fetchEventItems are mocked out entirely (canned in-memory
// data — no HTTP involved for event discovery). fetchBodyContact is left as
// the REAL implementation from _civic-legistar.ts; its own HTTP call is
// driven through a stubbed global `fetch`, the same pattern
// gov-solicitation.test.ts uses for fetchDescription. This means the
// transient-error test below actually exercises fetchBodyContact's real
// error-classification logic (5xx/429/network-error → retryable; a
// malformed/empty response or non-retryable 4xx → real negative) rather than
// a mock standing in for it.

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

/** Controls what the stubbed global `fetch` returns for the OfficeRecords call. */
type OfficeRecordsBehavior = "contact" | "no-email" | "throw" | "5xx";
let officeRecordsBehavior: OfficeRecordsBehavior = "contact";

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
    // fetchBodyContact is intentionally NOT overridden — the real
    // implementation runs, hitting the stubbed global `fetch` below.
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
      findProspectByEmail: () => null,
      isEmailPendingInQueue: (email: string) =>
        enqueued.some((row) => row.payload["email"] === email),
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
  officeRecordsBehavior = "contact";
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

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/OfficeRecords")) {
        if (officeRecordsBehavior === "throw") throw new Error("network down");
        if (officeRecordsBehavior === "5xx") {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        if (officeRecordsBehavior === "no-email") {
          return { ok: true, status: 200, json: async () => [] };
        }
        // Contact varies by body (via the URL's slug/bodyId segment) so
        // tests exercising multiple distinct bodies (e.g. multi-city runs)
        // don't collide with the same-body dedupe check.
        const bodyMatch = /\/(\w+)\/Bodies\/(\d+)\/OfficeRecords/.exec(url);
        const bodyKey = bodyMatch ? `${bodyMatch[1]}-${bodyMatch[2]}` : "default";
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              OfficeRecordFullName: "Alex Chen",
              OfficeRecordEmail: `alex.chen+${bodyKey}@council.nyc.gov`,
              OfficeRecordPhone: "555-0100",
              OfficeRecordTitle: "Chief of Staff",
            },
          ],
        };
      }
      throw new Error(`unexpected fetch call in civic-agenda test: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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
    expect(row.payload["email"]).toBe("alex.chen+nyc-10@council.nyc.gov");
    expect(row.payload["name"]).toBe("Alex Chen");
  });

  it("drops (does not persist) an item whose body publishes no member email", async () => {
    officeRecordsBehavior = "no-email";
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(pendingPersisted).toHaveLength(0);
  });

  it("persists for retry when the contact lookup hits a network error", async () => {
    officeRecordsBehavior = "throw";
    const out = await runCivicAgendaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(pendingPersisted).toHaveLength(1);
    expect(pendingPersisted[0]!.playName).toBe("civic-agenda");
  });

  it("persists for retry when the contact lookup hits a 5xx", async () => {
    officeRecordsBehavior = "5xx";
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

  it("drops the second item as a duplicate when two agenda items from the same body resolve to the identical contact email", async () => {
    // Two distinct agenda items, same event/body → fetchBodyContact resolves
    // the identical office-holder contact for both, but each carries a
    // different item-level dedupeKey. Without the cross-play/same-contact
    // email check, both would enqueue as separate rows to the same email.
    itemsByEventId = {
      1: [
        { eventItemId: 100, title: "Resolution on AI use in permitting", matterFile: "R-1" },
        { eventItemId: 102, title: "AI automation budget amendment", matterFile: null },
      ],
    };
    const out = await runCivicAgendaFinder(baseConfig);
    expect(icpCalls).toBe(2);
    expect(out.enqueued).toBe(1);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload["email"]).toBe("alex.chen+nyc-10@council.nyc.gov");
  });

  it("accounts for icpFilter spend in result.costUsd so maxCostUsd can halt the run", async () => {
    // Regression for #503: icpFilter is the ONLY paid call this finder makes
    // (fetchBodyContact is a free, keyless Legistar lookup) — before the fix,
    // result.costUsd never left 0, so maxCostUsd could never trip regardless
    // of classifier spend.
    itemsByEventId = {
      1: [
        { eventItemId: 100, title: "Resolution on AI use in permitting", matterFile: "R-1" },
        { eventItemId: 102, title: "AI automation budget amendment", matterFile: null },
      ],
    };
    const unlimited = await runCivicAgendaFinder(baseConfig);
    expect(icpCalls).toBe(2);
    expect(unlimited.costUsd).toBeGreaterThan(0);
    expect(unlimited.costUsd).toBeCloseTo(0.002, 5);

    icpCalls = 0;
    enqueued.length = 0;
    const capped = await runCivicAgendaFinder({ ...baseConfig, maxCostUsd: 0.001 });
    // The cap is checked before each icpFilter call: one call is allowed
    // through (costUsd 0 < 0.001), which pushes costUsd to 0.001 and halts
    // the loop before the second candidate's classifier call.
    expect(icpCalls).toBe(1);
    expect(capped.halted).toMatch(/max-cost cap/);
  });
});

describe("runCivicAgendaFinder — max-cost cap", () => {
  it("halts BEFORE the paid icpFilter call when maxCostUsd is positive but below one call's cost", async () => {
    // Regression for finding PRRT_kwDOSKzrBs6fGix5: the guard used to check
    // costUsd (still 0 at this point) instead of the PROSPECTIVE cost, so
    // 0 < maxCostUsd < ICP_FILTER_COST_USD let the call through anyway.
    const out = await runCivicAgendaFinder({ ...baseConfig, maxCostUsd: 0.0001 });
    expect(icpCalls).toBe(0);
    expect(out.enqueued).toBe(0);
    expect(out.halted).toMatch(/max-cost cap/);
  });

  it("still allows the call when maxCostUsd comfortably covers one icpFilter call", async () => {
    const out = await runCivicAgendaFinder({ ...baseConfig, maxCostUsd: 1 });
    expect(icpCalls).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(out.halted).toBeUndefined();
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
