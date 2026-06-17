import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", () => ({ logEvent: () => {} }));

const { cityToSlug, fetchCityEvents, eventNameMatchesTopics, fetchEventDetails } =
  await import("../src/_luma-discover.ts");

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
      // Real Luma shape: the blurb is a ProseMirror doc, with zero-width spaces.
      description_mirror: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "​Build autonomous agents in a day." }] },
          { type: "paragraph", content: [{ type: "text", text: "For builders shipping real tool-use." }] },
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
