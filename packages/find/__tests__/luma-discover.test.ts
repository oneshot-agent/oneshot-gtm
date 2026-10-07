import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", () => ({ logEvent: () => {} }));

const {
  cityToSlug,
  fetchCityEvents,
  eventNameMatchesTopics,
  fetchEventDetails,
  fetchPlaceEvents,
  fetchCalendarEvents,
  parseCalendarRef,
  cityFromGeo,
} = await import("../src/_luma-discover.ts");

function htmlWithNextData(data: unknown): string {
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    data,
  )}</script></body></html>`;
}

function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("cityToSlug", () => {
  it("maps known hubs, case- and whitespace-insensitive", () => {
    expect(cityToSlug("San Francisco")).toBe("sf");
    expect(cityToSlug("  NEW YORK city ")).toBe("nyc");
    expect(cityToSlug("London")).toBe("london");
  });
  it("returns null for unmapped cities", () => {
    expect(cityToSlug("Reykjavik")).toBeNull();
  });
  // Vienna sat in the live trigger config for weeks with no slug, so every
  // tick silently took the weaker webSearch path instead of the city page.
  it("maps the DACH/CEE hubs, including local-language names", () => {
    expect(cityToSlug("Vienna")).toBe("vienna");
    expect(cityToSlug("Wien")).toBe("vienna");
    expect(cityToSlug("Prague")).toBe("prague");
    expect(cityToSlug("Praha")).toBe("prague");
    expect(cityToSlug("Berlin")).toBe("berlin");
    expect(cityToSlug("Amsterdam")).toBe("amsterdam");
  });
});

describe("eventNameMatchesTopics", () => {
  const topics = ["AI agents", "MCP", "LLM hackers"];
  it("matches on a word-boundary topic token", () => {
    expect(eventNameMatchesTopics("Artificial Analysis Coding Agent Benchmark", topics)).toBe(true);
    expect(eventNameMatchesTopics("ClickHouse + Hex AI hackathon", topics)).toBe(true);
    expect(eventNameMatchesTopics("MCP Night by WorkOS", topics)).toBe(true);
  });
  it("rejects events with no topic token", () => {
    expect(eventNameMatchesTopics("Evening Yoga Session", topics)).toBe(false);
    expect(eventNameMatchesTopics("Dance Cardio with Sarah", topics)).toBe(false);
  });
  it("does not substring-match (no 'ai' inside 'Maizie')", () => {
    expect(eventNameMatchesTopics("Maizie's Wine Tasting", ["AI"])).toBe(false);
  });
  it("is a no-op (passes everything) when topics is empty", () => {
    expect(eventNameMatchesTopics("Evening Yoga Session", [])).toBe(true);
  });
});

describe("fetchCityEvents", () => {
  it("collects event-shaped objects out of __NEXT_DATA__ (slug/name/start/city)", async () => {
    const data = {
      props: {
        pageProps: {
          entries: [
            {
              api_id: "evt-1", // wrapper has no start_at → not matched (no dup)
              event: {
                api_id: "evt-1",
                name: "Upcoming AI Night",
                start_at: "2026-06-20T18:00:00.000Z",
                url: "abc123",
                geo_address_info: { city: "San Francisco" },
              },
            },
            {
              api_id: "evt-2",
              event: {
                api_id: "evt-2",
                name: " Cafe Cursor ",
                start_at: "2026-06-21T17:00:00.000Z",
                url: "def456",
                geo_address_info: { city: "San Francisco" },
              },
            },
          ],
        },
      },
    };
    stubFetch(async () => ({ ok: true, status: 200, text: async () => htmlWithNextData(data) }));

    const events = await fetchCityEvents("sf");
    expect(events).toHaveLength(2);
    // Order-independent: traversal order isn't part of the contract.
    expect(events).toEqual(
      expect.arrayContaining([
        {
          slug: "abc123",
          name: "Upcoming AI Night",
          startAtIso: "2026-06-20T18:00:00.000Z",
          city: "San Francisco",
        },
        {
          slug: "def456",
          name: "Cafe Cursor", // trimmed
          startAtIso: "2026-06-21T17:00:00.000Z",
          city: "San Francisco",
        },
      ]),
    );
  });

  it("ignores non-event nodes (full-URL `url`, missing fields) and null geo", async () => {
    const data = {
      decoy: { api_id: "evt-x", name: "No date", url: "https://example.com/x" }, // url has '/', no start_at
      list: [
        {
          api_id: "evt-ok",
          name: "Real Event",
          start_at: "2026-07-01T00:00:00.000Z",
          url: "ghi789",
          // no geo_address_info → city null
        },
      ],
    };
    stubFetch(async () => ({ ok: true, status: 200, text: async () => htmlWithNextData(data) }));
    const events = await fetchCityEvents("sf");
    expect(events).toEqual([
      { slug: "ghi789", name: "Real Event", startAtIso: "2026-07-01T00:00:00.000Z", city: null },
    ]);
  });

  it("returns null when the page has no __NEXT_DATA__", async () => {
    stubFetch(async () => ({ ok: true, status: 200, text: async () => "<html>nope</html>" }));
    expect(await fetchCityEvents("sf")).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    stubFetch(async () => ({ ok: false, status: 404, text: async () => "" }));
    expect(await fetchCityEvents("nope")).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchCityEvents("sf")).toBeNull();
  });

  it("returns null for an empty slug without fetching", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", f);
    expect(await fetchCityEvents("")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fetchEventDetails", () => {
  const urlPayload = {
    data: {
      api_id: "evt-abc",
      name: "AI Agents Hackathon",
      start_at: "2026-06-20T18:00:00.000Z",
      // Luma states the zone the host set alongside the instant. It's the most
      // authoritative input to the date rendering, so it must survive the parse.
      timezone: "America/Los_Angeles",
      // Real Luma shape: the blurb is a ProseMirror doc, with zero-width spaces.
      description_mirror: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "​Build autonomous agents in a day." }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "For builders shipping real tool-use." }],
          },
        ],
      },
      geo_address_info: { city: "San Francisco" },
      hosts: [
        {
          name: "Daniel G Wilson",
          username: "danielg",
          website: "https://danielgwilson.com",
          linkedin_handle: "/in/danielgwilson",
          twitter_handle: "the_danny_g",
          bio_short: "Mental health + AI founder",
        },
      ],
      featured_guests: [
        {
          name: "Carl Vincent Kho",
          username: null,
          website: "https://carlkho.com/",
          linkedin_handle: "/in/carlkho",
          twitter_handle: null,
          bio_short: "Google GenAI Hackathon Winner.",
        },
        // Host also featured → deduped by name (Host entry wins).
        { name: "Daniel G Wilson", linkedin_handle: "/in/danielgwilson" },
        // Nameless entry → skipped.
        { name: "  ", linkedin_handle: "/in/ghost" },
      ],
    },
  };

  function stubJsonFetch(impl: () => Promise<unknown>): void {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  it("maps hosts + featured guests with normalized links, hosts first, deduped", async () => {
    stubJsonFetch(async () => ({ ok: true, status: 200, json: async () => urlPayload }));
    const d = await fetchEventDetails("abc123");
    expect(d).not.toBeNull();
    expect(d!.eventTitle).toBe("AI Agents Hackathon");
    expect(d!.eventDateIso).toBe("2026-06-20T18:00:00.000Z");
    expect(d!.eventTimezone).toBe("America/Los_Angeles");
    expect(d!.eventCity).toBe("San Francisco");
    // ProseMirror flattened to one line; zero-width spaces stripped.
    expect(d!.eventDescription).toBe(
      "Build autonomous agents in a day. For builders shipping real tool-use.",
    );
    expect(d!.attendees).toHaveLength(2);
    const host = d!.attendees.find((a) => a.role === "Host");
    expect(host).toMatchObject({
      name: "Daniel G Wilson",
      linkedinUrl: "https://www.linkedin.com/in/danielgwilson",
      websiteUrl: "https://danielgwilson.com",
      twitterUrl: "https://x.com/the_danny_g",
      profileUrl: "https://luma.com/user/danielg",
    });
    const guest = d!.attendees.find((a) => a.role === "Guest");
    expect(guest).toMatchObject({
      name: "Carl Vincent Kho",
      linkedinUrl: "https://www.linkedin.com/in/carlkho",
      websiteUrl: "https://carlkho.com/",
      profileUrl: null,
    });
  });

  it("returns details with hosts only when the guest list is hidden", async () => {
    const hidden = {
      data: {
        api_id: "evt-h",
        name: "Private-ish Mixer",
        start_at: "2026-06-22T18:00:00.000Z",
        hosts: [{ name: "Org Anizer", linkedin_handle: "in/organizer" }],
      },
    };
    stubJsonFetch(async () => ({ ok: true, status: 200, json: async () => hidden }));
    const d = await fetchEventDetails("hidden1");
    expect(d!.attendees).toEqual([
      expect.objectContaining({
        name: "Org Anizer",
        role: "Host",
        linkedinUrl: "https://www.linkedin.com/in/organizer",
      }),
    ]);
    expect(d!.eventCity).toBeNull();
    expect(d!.eventDescription).toBeNull();
    // No `timezone` on the payload → null, so the caller falls through to the
    // city and then the install zone rather than inheriting a wrong guess.
    expect(d!.eventTimezone).toBeNull();
  });

  it("ignores a blank or non-string timezone rather than passing it on", async () => {
    for (const tz of ["", "   ", 42, null]) {
      const payload = {
        data: {
          api_id: "evt-tz",
          name: "Zoneless Mixer",
          start_at: "2026-06-22T18:00:00.000Z",
          timezone: tz,
          hosts: [{ name: "Org Anizer", linkedin_handle: "in/organizer" }],
        },
      };
      stubJsonFetch(async () => ({ ok: true, status: 200, json: async () => payload }));
      const d = await fetchEventDetails("tz1");
      expect(d!.eventTimezone).toBeNull();
    }
  });

  it("falls back to description_short when the event has no description_mirror", async () => {
    const seriesBlurb = {
      data: {
        api_id: "evt-s",
        name: "Weekly AI Office Hours",
        start_at: "2026-06-24T18:00:00.000Z",
        hosts: [{ name: "Host One", linkedin_handle: "in/host1" }],
        calendar: {
          api_id: "cal-x",
          description_short: "Open stage for AI builders to share and transform.",
        },
      },
    };
    stubJsonFetch(async () => ({ ok: true, status: 200, json: async () => seriesBlurb }));
    const d = await fetchEventDetails("series1");
    expect(d!.eventDescription).toBe("Open stage for AI builders to share and transform.");
  });

  it("returns null on non-2xx / bad JSON / fetch rejection / empty slug", async () => {
    stubJsonFetch(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not found." }),
    }));
    expect(await fetchEventDetails("nope")).toBeNull();

    stubJsonFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }));
    expect(await fetchEventDetails("bad")).toBeNull();

    stubJsonFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchEventDetails("down")).toBeNull();

    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", f);
    expect(await fetchEventDetails("")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null when the payload has neither an event node nor people", async () => {
    stubJsonFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }));
    expect(await fetchEventDetails("empty")).toBeNull();
  });
});

// Paged discovery: city feeds and calendars

const DAY = 24 * 3600 * 1000;
const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString();

/** One api.lu.ma listing entry, in the shape `calendar/get-items` and the discover feed return. */
function entry(slug: string, offsetDays: number): Record<string, unknown> {
  return {
    api_id: `calev-${slug}`,
    event: { api_id: `evt-${slug}`, name: `Event ${slug}`, start_at: iso(offsetDays), url: slug },
  };
}

/**
 * Route fetches by URL: Luma pages (`luma.com/<slug>`) serve `__NEXT_DATA__`,
 * api.lu.ma listings serve pages keyed by `period` (calendar) or `place`
 * (feed) and the cursor. Records every URL requested.
 */
function fakeLuma(opts: {
  pages?: Record<string, unknown>;
  listings?: Record<string, Array<{ entries: unknown[]; has_more: boolean }>>;
  failListings?: boolean;
}): string[] {
  const requested: string[] = [];
  stubFetch(async () => ({ ok: false, status: 500 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requested.push(input);
      const url = new URL(input);
      if (url.hostname === "luma.com") {
        const data = opts.pages?.[url.pathname.slice(1)];
        return data === undefined
          ? { ok: false, status: 404 }
          : { ok: true, status: 200, text: async () => htmlWithNextData(data) };
      }
      if (opts.failListings) return { ok: false, status: 500 };
      const key =
        url.searchParams.get("period") ?? url.searchParams.get("discover_place_api_id") ?? "";
      const pages = opts.listings?.[key] ?? [];
      const index = Number(url.searchParams.get("pagination_cursor") ?? "0");
      const page = pages[index] ?? { entries: [], has_more: false };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...page,
          next_cursor: page.has_more ? String(index + 1) : null,
        }),
      };
    }),
  );
  return requested;
}

describe("parseCalendarRef", () => {
  it("accepts a cal- id, a bare slug, and luma.com / lu.ma URLs", () => {
    expect(parseCalendarRef("cal-bR2dxhC1V6wCtK8")).toEqual({ apiId: "cal-bR2dxhC1V6wCtK8" });
    expect(parseCalendarRef(" sftw ")).toEqual({ slug: "sftw" });
    expect(parseCalendarRef("https://luma.com/sftw")).toEqual({ slug: "sftw" });
    expect(parseCalendarRef("lu.ma/latw")).toEqual({ slug: "latw" });
  });

  it("rejects blanks, nested paths and other hosts", () => {
    expect(parseCalendarRef("  ")).toBeNull();
    expect(parseCalendarRef("https://luma.com/sftw/events")).toBeNull();
    expect(parseCalendarRef("tech week")).toBeNull();
  });
});

describe("fetchCalendarEvents", () => {
  const calendarPage = {
    props: {
      pageProps: {
        // Calendar pages embed other calendars too; the slug picks the right one.
        featured: [{ api_id: "cal-other", name: "Someone Else", slug: "other" }],
        calendar: { api_id: "cal-tw", name: "San Francisco Tech Week", slug: "sftw" },
      },
    },
  };

  it("resolves the slug, pages future events, and stops once past the window", async () => {
    const requested = fakeLuma({
      pages: { sftw: calendarPage },
      listings: {
        future: [
          { entries: [entry("a", 1), entry("b", 2)], has_more: true },
          { entries: [entry("c", 3), entry("far", 30)], has_more: true },
          { entries: [entry("never", 40)], has_more: false },
        ],
      },
    });

    // A window that starts ahead of now never reads `period=past` (a bare
    // Date.now() can fall a millisecond behind the fetcher's own clock read).
    const out = await fetchCalendarEvents("sftw", {
      fromMs: Date.now() + 3_600_000,
      toMs: Date.now() + 14 * DAY,
    });

    expect(out?.calendarApiId).toBe("cal-tw");
    expect(out?.calendarName).toBe("San Francisco Tech Week");
    expect(out?.events.map((ev) => ev.slug)).toEqual(["a", "b", "c"]);
    // Page 2 crossed the window end, so page 3 was never requested; no past read.
    expect(requested.filter((u) => u.includes("get-items"))).toHaveLength(2);
    expect(requested.some((u) => u.includes("period=past"))).toBe(false);
    expect(requested.some((u) => u.includes("calendar_api_id=cal-tw"))).toBe(true);
  });

  it("reads past events back to fromMs when the window starts in the past", async () => {
    fakeLuma({
      listings: {
        future: [{ entries: [entry("today", 0.1), entry("tomorrow", 1)], has_more: false }],
        // Newest first; the page that reaches before fromMs ends the walk.
        past: [
          { entries: [entry("yesterday", -1), entry("monday", -2)], has_more: true },
          { entries: [entry("too-old", -9)], has_more: true },
          { entries: [entry("never", -20)], has_more: false },
        ],
      },
    });

    const out = await fetchCalendarEvents("cal-tw", {
      fromMs: Date.now() - 3 * DAY,
      toMs: Date.now() + 14 * DAY,
    });

    expect(out?.events.map((ev) => ev.slug).toSorted()).toEqual(
      ["monday", "today", "tomorrow", "yesterday"].toSorted(),
    );
  });

  it("returns null when the calendar slug can't be resolved or the listing fails", async () => {
    fakeLuma({ pages: { sftw: { props: { pageProps: {} } } } });
    expect(await fetchCalendarEvents("sftw", { fromMs: 0, toMs: Date.now() + DAY })).toBeNull();

    fakeLuma({ failListings: true });
    expect(
      await fetchCalendarEvents("cal-tw", { fromMs: Date.now(), toMs: Date.now() + DAY }),
    ).toBeNull();

    expect(await fetchCalendarEvents("", { fromMs: 0, toMs: 1 })).toBeNull();
  });
});

describe("fetchPlaceEvents", () => {
  const cityPage = {
    props: {
      pageProps: {
        place: { api_id: "discplace-sf", name: "San Francisco", slug: "sf" },
        nearby: [{ api_id: "discplace-oak", name: "Oakland", slug: "oakland" }],
        entries: [entry("on-page", 1)],
      },
    },
  };

  it("pages the city's feed by its discplace id, keeping the city page's own events", async () => {
    const requested = fakeLuma({
      pages: { sf: cityPage },
      listings: {
        "discplace-sf": [
          { entries: [entry("on-page", 1), entry("f1", 2)], has_more: true },
          { entries: [entry("f2", 3), entry("far", 30)], has_more: true },
          { entries: [entry("never", 40)], has_more: false },
        ],
      },
    });

    const events = await fetchPlaceEvents("sf", { toMs: Date.now() + 14 * DAY });

    expect(events?.map((ev) => ev.slug).toSorted()).toEqual(
      ["f1", "f2", "far", "on-page"].toSorted(),
    );
    expect(requested.filter((u) => u.includes("get-paginated-events"))).toHaveLength(2);
    expect(requested.every((u) => !u.includes("discplace-oak"))).toBe(true);
  });

  it("falls back to the city page's events when the feed fails or the page has no place id", async () => {
    fakeLuma({ pages: { sf: cityPage }, failListings: true });
    expect(
      (await fetchPlaceEvents("sf", { toMs: Date.now() + DAY }))?.map((ev) => ev.slug),
    ).toEqual(["on-page"]);

    const noPlace = { props: { pageProps: { entries: [entry("on-page", 1)] } } };
    const requested = fakeLuma({ pages: { sf: noPlace } });
    expect(
      (await fetchPlaceEvents("sf", { toMs: Date.now() + DAY }))?.map((ev) => ev.slug),
    ).toEqual(["on-page"]);
    expect(requested.some((u) => u.includes("api.lu.ma"))).toBe(false);
  });

  it("returns null when the city page itself fails", async () => {
    fakeLuma({});
    expect(await fetchPlaceEvents("sf", { toMs: Date.now() + DAY })).toBeNull();
  });
});

describe("cityFromGeo", () => {
  it("prefers `city`, then `city_state`, then a US-style manual address", () => {
    expect(cityFromGeo({ city: "San Francisco", address: "x" })).toBe("San Francisco");
    expect(cityFromGeo({ city_state: "San Francisco, CA" })).toBe("San Francisco");
    expect(cityFromGeo({ type: "manual", address: "639 Howard St, San Francisco, CA" })).toBe(
      "San Francisco",
    );
    expect(cityFromGeo({ full_address: "1 Main St, Austin, TX 78701, USA" })).toBe("Austin");
  });

  it("returns null when nothing names a city", () => {
    expect(cityFromGeo(null)).toBeNull();
    expect(cityFromGeo({ mode: "obfuscated" })).toBeNull();
    expect(cityFromGeo({ address: "The Warehouse" })).toBeNull();
    expect(cityFromGeo({ city: "  " })).toBeNull();
  });
});

describe("fetchEventDetails — the page's own event", () => {
  it("ignores an event card embedded in the description", async () => {
    // Real shape (luma.com/seamate-tdd8): the page's event sits under
    // data.event; the description links ANOTHER event as a full evt- node.
    const payload = {
      data: {
        api_id: "evt-own",
        start_at: "2026-10-09T00:00:00.000Z",
        event: {
          api_id: "evt-own",
          name: "Your Agent Thinks Too Much",
          start_at: "2026-10-09T00:00:00.000Z",
          timezone: "America/Los_Angeles",
          geo_address_info: { mode: "obfuscated", city: "San Francisco" },
        },
        description_mirror: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Also join us at:" }] },
            {
              type: "luma-event",
              attrs: {
                event: {
                  api_id: "evt-other",
                  name: "IDA AI Summit 2026",
                  start_at: "2026-10-18T20:00:00.000Z",
                },
              },
            },
          ],
        },
        hosts: [{ name: "Host Person", linkedin_handle: "/in/host" }],
      },
    };
    stubFetch(async () => ({ ok: true, status: 200, json: async () => payload }));

    const details = await fetchEventDetails("seamate-tdd8");

    expect(details?.eventTitle).toBe("Your Agent Thinks Too Much");
    expect(details?.eventDateIso).toBe("2026-10-09T00:00:00.000Z");
    expect(details?.eventCity).toBe("San Francisco");
    // The description text still comes through.
    expect(details?.eventDescription).toContain("Also join us at:");
  });

  it("reads the city off a manual address", async () => {
    const payload = {
      data: {
        event: {
          api_id: "evt-manual",
          name: "Cursed Agents and Beer",
          start_at: "2026-10-09T02:30:00.000Z",
          geo_address_info: {
            type: "manual",
            address: "639 Howard St, San Francisco, CA",
            mode: "shown",
          },
        },
        hosts: [{ name: "Host Person", linkedin_handle: "/in/host" }],
      },
    };
    stubFetch(async () => ({ ok: true, status: 200, json: async () => payload }));

    expect((await fetchEventDetails("freestyle-5ouz"))?.eventCity).toBe("San Francisco");
  });
});
