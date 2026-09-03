import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {} };
});

const {
  cityToLegistarSlug,
  fetchCityEvents,
  fetchEventItems,
  fetchBodyContact,
  pickOfficeContact,
  agendaItemMatchesKeywords,
} = await import("../src/_civic-legistar.ts");

function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("cityToLegistarSlug", () => {
  it("maps known cities, case- and whitespace-insensitive", () => {
    expect(cityToLegistarSlug("New York")).toBe("nyc");
    expect(cityToLegistarSlug("  chicago ")).toBe("chicago");
    expect(cityToLegistarSlug("SAN FRANCISCO")).toBe("sfgov");
  });
  it("returns null for unmapped cities", () => {
    expect(cityToLegistarSlug("Reykjavik")).toBeNull();
  });
});

describe("agendaItemMatchesKeywords", () => {
  const keywords = ["AI", "automation", "permitting software"];
  it("matches on a word-boundary token", () => {
    expect(agendaItemMatchesKeywords("Resolution on AI use in city services", keywords)).toBe(true);
    expect(agendaItemMatchesKeywords("Contract for automation of records", keywords)).toBe(true);
  });
  it("rejects items with no keyword token", () => {
    expect(agendaItemMatchesKeywords("Appointment of a new librarian", keywords)).toBe(false);
  });
  it("does not substring-match", () => {
    expect(agendaItemMatchesKeywords("Maintenance of city vehicles", ["AI"])).toBe(false);
  });
  it("gates everything (never passes) when keywords is empty", () => {
    expect(agendaItemMatchesKeywords("Anything at all", [])).toBe(false);
  });
});

describe("fetchCityEvents", () => {
  it("parses a JSON array of GranicusEvent-shaped objects", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          EventId: 1,
          EventBodyId: 10,
          EventBodyName: "CITY COUNCIL",
          EventDate: "2026-09-10T00:00:00",
          EventTime: "10:00 AM",
          EventLocation: "City Hall",
          EventAgendaFile: "https://example.com/agenda.pdf",
          EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?ID=1",
        },
        // Missing EventDate → filtered out, not a throw.
        { EventId: 2, EventBodyName: "COMMITTEE" },
      ],
    }));
    const events = await fetchCityEvents("nyc", 30);
    expect(events).toHaveLength(1);
    expect(events![0]).toMatchObject({
      eventId: 1,
      eventBodyId: 10,
      eventBodyName: "CITY COUNCIL",
      eventDateIso: "2026-09-10T00:00:00",
      eventTime: "10:00 AM",
    });
  });

  it("returns null on a non-2xx response", async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await fetchCityEvents("nyc", 30)).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchCityEvents("nyc", 30)).toBeNull();
  });

  it("returns null for an empty slug without fetching", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", f);
    expect(await fetchCityEvents("", 30)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null when the response isn't an array", async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ error: "bad" }) }));
    expect(await fetchCityEvents("nyc", 30)).toBeNull();
  });

  it("floors the lower filter bound to the start of today, not the current instant — so a same-day meeting that already started isn't excluded", async () => {
    // Freeze "now" to mid-afternoon on the meeting's own day. A lower bound
    // of the exact instant (old behavior) would read
    // `EventDate ge datetime'2026-09-10T15:30:00'`, which excludes a
    // meeting stamped at that day's midnight — the meeting has already
    // "started" relative to the instant, per Legistar's date-only semantics.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T15:30:00Z"));
    let capturedUrl = "";
    stubFetch(async (...args: unknown[]) => {
      capturedUrl = args[0] as string;
      return { ok: true, status: 200, json: async () => [] };
    });
    await fetchCityEvents("nyc", 30);
    vi.useRealTimers();
    const filterParam = decodeURIComponent(/\$filter=([^&]+)/.exec(capturedUrl)![1]!);
    expect(filterParam).toContain("EventDate ge datetime'2026-09-10T00:00:00'");
  });

  it("floors to the CITY's local calendar day, not UTC's — so a run just after UTC midnight in a UTC-west city doesn't skip that city's still-current day", async () => {
    // 2026-09-10T02:00:00Z is already Sep 10 in UTC, but only 18:00 on
    // Sep 9 in Los Angeles (UTC-8). The old UTC-day flooring would emit a
    // lower bound of 2026-09-10, which is tomorrow relative to LA's actual
    // "today" and would exclude the rest of LA's Sep 9 meetings.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T02:00:00Z"));
    let capturedUrl = "";
    stubFetch(async (...args: unknown[]) => {
      capturedUrl = args[0] as string;
      return { ok: true, status: 200, json: async () => [] };
    });
    await fetchCityEvents("lacity", 30, "Los Angeles");
    vi.useRealTimers();
    const filterParam = decodeURIComponent(/\$filter=([^&]+)/.exec(capturedUrl)![1]!);
    expect(filterParam).toContain("EventDate ge datetime'2026-09-09T00:00:00'");
  });

  it("falls back to UTC when the city is unmapped or omitted — same as previous behavior, not a guess", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T02:00:00Z"));
    let capturedUrl = "";
    stubFetch(async (...args: unknown[]) => {
      capturedUrl = args[0] as string;
      return { ok: true, status: 200, json: async () => [] };
    });
    await fetchCityEvents("nyc", 30, "Reykjavik");
    vi.useRealTimers();
    const filterParam = decodeURIComponent(/\$filter=([^&]+)/.exec(capturedUrl)![1]!);
    expect(filterParam).toContain("EventDate ge datetime'2026-09-10T00:00:00'");
  });
});

describe("fetchEventItems", () => {
  it("parses event items, falling back to EventItemMatterName for a blank title", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { EventItemId: 1, EventItemTitle: "Resolution on AI use", EventItemMatterFile: "R-1" },
        { EventItemId: 2, EventItemTitle: "", EventItemMatterName: "Fallback title" },
        // No title at all anywhere → dropped.
        { EventItemId: 3 },
      ],
    }));
    const items = await fetchEventItems("nyc", 1);
    expect(items).toHaveLength(2);
    expect(items![0]).toMatchObject({
      eventItemId: 1,
      title: "Resolution on AI use",
      matterFile: "R-1",
    });
    expect(items![1]).toMatchObject({ eventItemId: 2, title: "Fallback title" });
  });

  it("drops a null/malformed element without discarding the rest — mirrors parseEvent's guard", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { EventItemId: 1, EventItemTitle: "Resolution on AI use", EventItemMatterFile: "R-1" },
        // A null/non-object element (malformed upstream payload) must not
        // throw inside the outer .map — that would trip fetchEventItems'
        // catch and silently drop every valid item for the event, not just
        // this one malformed element.
        null,
        "unexpected-string",
      ],
    }));
    const items = await fetchEventItems("nyc", 1);
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({ eventItemId: 1, title: "Resolution on AI use" });
  });

  it("returns null on non-2xx / fetch rejection / empty inputs", async () => {
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await fetchEventItems("nyc", 1)).toBeNull();

    stubFetch(async () => {
      throw new Error("boom");
    });
    expect(await fetchEventItems("nyc", 1)).toBeNull();

    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", f);
    expect(await fetchEventItems("", 1)).toBeNull();
    expect(await fetchEventItems("nyc", Number.NaN)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("pickOfficeContact", () => {
  it("prefers a chair/president/clerk/secretary title over the first record", () => {
    const records = [
      { fullName: "Member One", email: "one@city.gov", phone: null, title: "Council Member" },
      { fullName: "Chair Two", email: "two@city.gov", phone: null, title: "Committee Chair" },
    ];
    expect(pickOfficeContact(records)?.fullName).toBe("Chair Two");
  });

  it("falls back to the first record with an email when no preferred title exists", () => {
    const records = [
      { fullName: "Member One", email: "one@city.gov", phone: null, title: "Council Member" },
      { fullName: "Member Two", email: "two@city.gov", phone: null, title: "Council Member" },
    ];
    expect(pickOfficeContact(records)?.fullName).toBe("Member One");
  });

  it("returns null when no record has an email", () => {
    const records = [{ fullName: "Member One", email: "", phone: null, title: null }];
    expect(pickOfficeContact(records)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickOfficeContact([])).toBeNull();
  });
});

describe("fetchBodyContact", () => {
  it("fetches office records and returns the preferred contact", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          OfficeRecordFullName: "Jamie Ruiz",
          OfficeRecordEmail: "jamie.ruiz@city.gov",
          OfficeRecordPhone: "555-0100",
          OfficeRecordTitle: "Committee Chair",
        },
      ],
    }));
    const outcome = await fetchBodyContact("nyc", 10);
    expect(outcome).toEqual({
      ok: true,
      contact: {
        fullName: "Jamie Ruiz",
        email: "jamie.ruiz@city.gov",
        phone: "555-0100",
        title: "Committee Chair",
      },
    });
  });

  it("returns ok:true with a null contact when the body publishes no member email", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ OfficeRecordFullName: "Jamie Ruiz", OfficeRecordEmail: "" }],
    }));
    expect(await fetchBodyContact("nyc", 10)).toEqual({ ok: true, contact: null });
  });

  it("returns a transient platform error on a 5xx or 429", async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await fetchBodyContact("nyc", 10)).toEqual({ ok: false, transient: true });

    stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await fetchBodyContact("nyc", 10)).toEqual({ ok: false, transient: true });
  });

  it("returns ok:true with a null contact (not a platform error) on a non-retryable 4xx like 404", async () => {
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await fetchBodyContact("nyc", 10)).toEqual({ ok: true, contact: null });
  });

  it("returns a transient platform error when fetch rejects (network failure)", async () => {
    stubFetch(async () => {
      throw new Error("boom");
    });
    expect(await fetchBodyContact("nyc", 10)).toEqual({ ok: false, transient: true });
  });

  it("returns ok:true with a null contact for an invalid bodyId or empty slug, without fetching", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", f);
    expect(await fetchBodyContact("nyc", 0)).toEqual({ ok: true, contact: null });
    expect(await fetchBodyContact("", 10)).toEqual({ ok: true, contact: null });
    expect(f).not.toHaveBeenCalled();
  });
});
