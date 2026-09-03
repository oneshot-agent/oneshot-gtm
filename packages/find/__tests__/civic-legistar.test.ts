import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", () => ({ logEvent: () => {} }));

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
    const contact = await fetchBodyContact("nyc", 10);
    expect(contact).toEqual({
      fullName: "Jamie Ruiz",
      email: "jamie.ruiz@city.gov",
      phone: "555-0100",
      title: "Committee Chair",
    });
  });

  it("returns null when the body publishes no member email", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ OfficeRecordFullName: "Jamie Ruiz", OfficeRecordEmail: "" }],
    }));
    expect(await fetchBodyContact("nyc", 10)).toBeNull();
  });

  it("returns null on non-2xx / fetch rejection / invalid bodyId", async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await fetchBodyContact("nyc", 10)).toBeNull();

    stubFetch(async () => {
      throw new Error("boom");
    });
    expect(await fetchBodyContact("nyc", 10)).toBeNull();

    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", f);
    expect(await fetchBodyContact("nyc", 0)).toBeNull();
    expect(await fetchBodyContact("", 10)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
