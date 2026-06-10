import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for runLumaFinder — mocks the SDK + helper boundaries the
// finder calls (webSearch, webRead, LLM extract, enrichProfile, findEmail,
// verifyEmail, enrichVerifiedContact, findLinkedInUrl, ICP filter, ledger).
//
// Each case drives a specific scenario by mutating the shared state vars in
// beforeEach + per-test setup. Concurrency = 1 isn't a knob here — runLumaFinder
// is parallel by design at 3 — but the helpers are deterministic per-call so
// ordering doesn't matter for the assertions below.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}

const enqueued: EnqueuedRow[] = [];
let icpMatch = true;
let webSearchResults: Array<{ url: string; title: string; description: string }> = [];
let webReadMarkdownByUrl: Record<string, string> = {};
let webReadThrowsForUrl: Set<string> = new Set();
let llmExtractByUrl: Record<string, string> = {}; // raw JSON string per URL
let enrichByLinkedinUrl: Record<
  string,
  {
    company?: string | null;
    company_domain?: string | null;
    email?: string | null;
    best_work_email?: string | null;
  }
> = {};
let findEmailReturn: { found: boolean; email: string | null } = {
  found: true,
  email: "x@acme.dev",
};
let verifyDeliverable = true;
let shouldSkipFindEmailResult: { ok: boolean; reason?: string } = { ok: true };
const sdkCalls = {
  webSearch: 0,
  webRead: 0,
  enrichProfile: 0,
  findEmail: 0,
  verifyEmail: 0,
  enrichVerifiedContact: 0,
  findLinkedInUrl: 0,
};

// City-page discovery. Default: null → finder falls back to webSearch (so the
// existing webSearch-driven cases below are unaffected). Discovery cases set
// `discoveredEvents`. cityToSlug maps the baseConfig city so discovery is tried.
let discoveredEvents: Array<{
  slug: string;
  name: string;
  startAtIso: string;
  city: string | null;
}> | null = null;
// Per-event structured details (api.lu.ma/url). Default: null → finder falls
// back to the webRead + LLM extract path the existing cases below exercise.
let eventDetails: {
  eventTitle: string | null;
  eventDateIso: string | null;
  eventCity: string | null;
  attendees: Array<Record<string, unknown>>;
} | null = null;
vi.mock("../src/_luma-discover.ts", () => ({
  cityToSlug: (city: string) => (city.trim().toLowerCase() === "san francisco" ? "sf" : null),
  fetchCityEvents: async () => discoveredEvents,
  fetchEventDetails: async () => eventDetails,
  // Keyword pre-filter is unit-tested in luma-discover.test.ts; let it pass here
  // so these integration cases exercise the event-level ICP gate + extract.
  eventNameMatchesTopics: () => true,
}));

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({ match: icpMatch, reason: icpMatch ? "fits" : "nope" }),
}));
vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => {
    sdkCalls.enrichVerifiedContact++;
    return { phone: "+15555550100", linkedinUrl: null, costUsd: 0.005, receiptId: 1 };
  },
}));
vi.mock("../src/_dedupe.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_dedupe.ts")>("../src/_dedupe.ts");
  return {
    ...actual,
    isDuplicate: () => false,
  };
});
vi.mock("../src/_findemail-prescreen.ts", () => ({
  shouldSkipFindEmail: () => shouldSkipFindEmailResult,
}));
vi.mock("../src/_linkedin.ts", () => ({
  isLinkedInProfileUrl: (u: string | null | undefined) =>
    typeof u === "string" && /linkedin\.com\/in\//i.test(u),
  findLinkedInUrl: async () => {
    sdkCalls.findLinkedInUrl++;
    return null;
  },
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    parallelMap: actual.parallelMap, // real impl preserves ordering
    webSearch: async () => {
      sdkCalls.webSearch++;
      return { result: { results: webSearchResults, cost: 0.01 }, receiptId: 1 };
    },
    webRead: async ({ url }: { url: string }) => {
      sdkCalls.webRead++;
      if (webReadThrowsForUrl.has(url)) throw new Error("transient webRead failure");
      return { result: { markdown: webReadMarkdownByUrl[url] ?? "", cost: 0.005 }, receiptId: 1 };
    },
    enrichProfile: async (input: { linkedinUrl?: string; email?: string }) => {
      sdkCalls.enrichProfile++;
      if (input.linkedinUrl) {
        const profile = enrichByLinkedinUrl[input.linkedinUrl] ?? {};
        return {
          result: { profile, cost: 0.005 },
          receiptId: 1,
        };
      }
      return { result: { profile: {}, cost: 0.005 }, receiptId: 1 };
    },
    findEmail: async () => {
      sdkCalls.findEmail++;
      return { result: { ...findEmailReturn, cost: 0.05 }, receiptId: 1 };
    },
    verifyEmail: async () => {
      sdkCalls.verifyEmail++;
      return { result: { deliverable: verifyDeliverable, cost: 0.005 }, receiptId: 1 };
    },
    getLedger: () => ({
      isQueueDuplicate: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

// LLM extract: the mock returns whatever raw JSON the test seeded for the URL
// (matched on `payload.url`). Default: empty fallback (the parser will accept
// `{}` and the finder treats it as a non-event page → skip).
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (opts: { messages: Array<{ role: string; content: string }> }) => {
      const userMsg = opts.messages.find((m) => m.role === "user")?.content ?? "{}";
      const parsed = JSON.parse(userMsg) as { url?: string };
      const url = parsed.url ?? "";
      const raw = llmExtractByUrl[url] ?? "{}";
      return { content: raw, provider: "t", model: "t" };
    },
  };
});

const { runLumaFinder } = await import("../src/luma.ts");

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}
function pastIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

beforeEach(() => {
  // Default to public-only mode regardless of the developer's local
  // LUMA_SESSION_COOKIE (applySecretsToEnv loads ~/.oneshot-gtm/.env on core
  // import) — otherwise fetchAuthedGuestList makes REAL network calls per
  // event. The auth-mode describe sets the cookie explicitly per test.
  delete process.env["LUMA_SESSION_COOKIE"];
  enqueued.length = 0;
  icpMatch = true;
  webSearchResults = [];
  webReadMarkdownByUrl = {};
  webReadThrowsForUrl = new Set();
  llmExtractByUrl = {};
  enrichByLinkedinUrl = {};
  findEmailReturn = { found: true, email: "x@acme.dev" };
  verifyDeliverable = true;
  shouldSkipFindEmailResult = { ok: true };
  discoveredEvents = null;
  eventDetails = null;
  for (const k of Object.keys(sdkCalls)) {
    (sdkCalls as Record<string, number>)[k] = 0;
  }
});
afterEach(() => vi.clearAllMocks());

const baseConfig = {
  dryRun: false,
  topics: ["AI"],
  cities: ["San Francisco"],
  yourEdge: "a 30-second teardown of how X handles Y",
  sinceDays: 30,
  limit: 25,
};

function event(
  url: string,
  override: Partial<{
    eventTitle: string;
    eventDateIso: string;
    eventCity: string;
    eventHasPassed: boolean;
    publicAttendees: Array<Record<string, unknown>>;
  }> = {},
): void {
  webSearchResults.push({ url, title: "AI Meetup", description: "..." });
  webReadMarkdownByUrl[url] = "# markdown body";
  const extract = {
    eventTitle: override.eventTitle ?? "SF AI Builders Meetup",
    eventDateIso: override.eventDateIso ?? futureIso(7),
    eventCity: override.eventCity ?? "San Francisco",
    eventHasPassed: override.eventHasPassed ?? false,
    publicAttendees: override.publicAttendees ?? [
      {
        name: "Alice",
        profileUrl: null,
        websiteUrl: "https://alice.dev",
        linkedinUrl: null,
        twitterUrl: null,
        bio: "Founder @ Acme",
        role: "Speaker",
      },
      {
        name: "Bob",
        profileUrl: null,
        websiteUrl: "https://bob.dev",
        linkedinUrl: null,
        twitterUrl: null,
        bio: null,
        role: null,
      },
    ],
  };
  llmExtractByUrl[url] = JSON.stringify(extract);
}

describe("runLumaFinder — city-page discovery", () => {
  it("uses discovered upcoming events and skips webSearch when the city page yields in-window hits", async () => {
    discoveredEvents = [
      { slug: "sf-evt-1", name: "SF AI Builders", startAtIso: futureIso(3), city: "San Francisco" },
      { slug: "sf-evt-old", name: "Past Meetup", startAtIso: pastIso(10), city: "San Francisco" },
    ];
    // Phase 2 read/extract for the in-window discovered event (its canonical URL).
    event("https://luma.com/sf-evt-1");

    const out = await runLumaFinder(baseConfig);

    // Discovery covered the city → webSearch never runs.
    expect(sdkCalls.webSearch).toBe(0);
    // The past event is window-filtered BEFORE Phase 2 → only one page is read.
    expect(sdkCalls.webRead).toBe(1);
    expect(out.enqueued).toBe(2); // 2 attendees on the in-window event
  });

  it("uses structured event details (hosts+guests with linkedin/website) and skips webRead entirely", async () => {
    discoveredEvents = [
      { slug: "sf-evt-1", name: "SF AI Builders", startAtIso: futureIso(3), city: "San Francisco" },
    ];
    eventDetails = {
      eventTitle: "SF AI Builders",
      eventDateIso: futureIso(3),
      eventCity: "San Francisco",
      attendees: [
        {
          name: "Dana Host",
          profileUrl: null,
          websiteUrl: null,
          linkedinUrl: "https://www.linkedin.com/in/dana",
          twitterUrl: null,
          bio: "Organizer",
          role: "Host",
        },
        {
          name: "Gabe Guest",
          profileUrl: null,
          websiteUrl: "https://gabe.dev",
          linkedinUrl: null,
          twitterUrl: null,
          bio: null,
          role: "Guest",
        },
      ],
    };
    // The host's linkedin enrichment surfaces a work email directly → no findEmail.
    enrichByLinkedinUrl["https://www.linkedin.com/in/dana"] = {
      best_work_email: "dana@org.com",
      company_domain: "org.com",
    };

    const out = await runLumaFinder(baseConfig);

    expect(sdkCalls.webRead).toBe(0); // structured details replaced the paid read+extract
    expect(out.enqueued).toBe(2);
    expect(enqueued).toHaveLength(2);
    const dana = enqueued.find((r) => r.payload["name"] === "Dana Host");
    expect(dana?.payload["email"]).toBe("dana@org.com");
    // Role surfaces in the payload (queue review) and flips the notes verb.
    expect(dana?.payload["role"]).toBe("Host");
    expect(dana?.notes).toContain("hosting");
    const gabe = enqueued.find((r) => r.payload["name"] === "Gabe Guest");
    expect(gabe?.payload["role"]).toBe("Guest");
    expect(gabe?.notes).toContain("going to");
    expect(sdkCalls.enrichProfile).toBe(1); // linkedin attendee only
    expect(sdkCalls.findEmail).toBe(1); // website attendee only
  });

  it("falls back to webSearch when discovery returns null", async () => {
    discoveredEvents = null;
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(sdkCalls.webSearch).toBe(1);
    expect(out.enqueued).toBe(2);
  });
});

describe("runLumaFinder — happy path", () => {
  it("enqueues each attendee once, with the event context stamped onto the row", async () => {
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(2);
    expect(out.droppedEnrichment).toBe(0);
    expect(out.droppedIcp).toBe(0);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.payload["eventTitle"]).toBe("SF AI Builders Meetup");
    expect(enqueued[0]?.payload["eventCity"]).toBe("San Francisco");
    expect(enqueued[0]?.payload["yourEdge"]).toBe(baseConfig.yourEdge);
    // 1 webSearch (1 topic × 1 city), 1 webRead, 2 attendees → 2 findEmail (no LinkedIn), 2 verifyEmail.
    expect(sdkCalls.findEmail).toBe(2);
    expect(sdkCalls.verifyEmail).toBe(2);
    expect(sdkCalls.enrichVerifiedContact).toBe(2);
  });

  it("filters non-event URLs (e.g. /discover, ?k=t) out before webRead", async () => {
    webSearchResults = [
      { url: "https://luma.com/discover", title: "Discover", description: "" },
      { url: "https://luma.com/ai?k=t", title: "AI category", description: "" },
      { url: "https://luma.com/abc", title: "Event", description: "" },
    ];
    webReadMarkdownByUrl["https://luma.com/abc"] = "# event";
    llmExtractByUrl["https://luma.com/abc"] = JSON.stringify({
      eventTitle: "X",
      eventDateIso: futureIso(3),
      eventCity: "SF",
      eventHasPassed: false,
      publicAttendees: [
        { name: "Alice", websiteUrl: "https://alice.dev" },
        { name: "Bob", websiteUrl: "https://bob.dev" },
      ],
    });
    const out = await runLumaFinder(baseConfig);
    expect(sdkCalls.webRead).toBe(1); // only the event page
    expect(out.candidates).toBe(1);
    expect(out.enqueued).toBe(2);
  });
});

describe("runLumaFinder — event-level drops", () => {
  it("drops events the LLM marks eventHasPassed: true", async () => {
    event("https://luma.com/past", { eventHasPassed: true });
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(sdkCalls.findEmail).toBe(0);
  });

  it("drops events with a past eventDateIso even when LLM says not-passed (defense)", async () => {
    event("https://luma.com/past", { eventHasPassed: false, eventDateIso: pastIso(7) });
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
  });

  it("drops events with no parseable eventDateIso", async () => {
    event("https://luma.com/nodate", { eventHasPassed: false, eventDateIso: "" });
    const out = await runLumaFinder({ ...baseConfig, topics: ["AI"], cities: ["SF"] });
    expect(out.enqueued).toBe(0);
  });

  it("drops events further out than sinceDays (forward-window cap)", async () => {
    event("https://luma.com/far", { eventDateIso: futureIso(90) });
    const out = await runLumaFinder({ ...baseConfig, sinceDays: 14 });
    expect(out.enqueued).toBe(0);
  });

  it("drops events with fewer than 2 publicAttendees (organizer didn't enable 'Show Who's Coming')", async () => {
    event("https://luma.com/private", {
      publicAttendees: [{ name: "Solo", websiteUrl: "https://solo.dev" }],
    });
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
  });
});

describe("runLumaFinder — contact resolution", () => {
  it("skips findEmail when LinkedIn enrichProfile surfaces best_work_email directly (cost savings)", async () => {
    enrichByLinkedinUrl["https://linkedin.com/in/alice"] = {
      company: "Acme",
      company_domain: "acme.dev",
      best_work_email: "alice@acme.dev",
    };
    event("https://luma.com/abc", {
      publicAttendees: [
        {
          name: "Alice",
          linkedinUrl: "https://linkedin.com/in/alice",
          websiteUrl: null,
          profileUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
        {
          name: "Bob",
          linkedinUrl: null,
          websiteUrl: "https://bob.dev",
          profileUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
      ],
    });
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(2);
    // Alice: enrichProfile → surfaced email → skip findEmail.
    // Bob: no LinkedIn, websiteUrl → findEmail uses websiteUrl.
    expect(sdkCalls.findEmail).toBe(1);
    expect(sdkCalls.enrichProfile).toBe(1);
  });

  it("falls back to findEmail with LinkedIn-resolved company_domain when email isn't surfaced", async () => {
    enrichByLinkedinUrl["https://linkedin.com/in/alice"] = {
      company: "Acme",
      company_domain: "acme.dev",
      best_work_email: null,
      email: null,
    };
    event("https://luma.com/abc", {
      publicAttendees: [
        {
          name: "Alice",
          linkedinUrl: "https://linkedin.com/in/alice",
          websiteUrl: null,
          profileUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
        {
          name: "Bob",
          linkedinUrl: null,
          websiteUrl: "https://bob.dev",
          profileUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
      ],
    });
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(2);
    expect(sdkCalls.findEmail).toBe(2);
  });

  it("drops an attendee with no LinkedIn AND no website (no contact domain)", async () => {
    event("https://luma.com/abc", {
      publicAttendees: [
        {
          name: "Ghost",
          linkedinUrl: null,
          websiteUrl: null,
          profileUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
        // Need a second attendee to clear the <2 gate; this one is fine.
        {
          name: "Bob",
          linkedinUrl: null,
          websiteUrl: "https://bob.dev",
          profileUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
      ],
    });
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.droppedEnrichment).toBe(1);
  });
});

describe("runLumaFinder — per-attendee filters", () => {
  it("drops the whole event at the ICP/topic gate, before any webRead", async () => {
    // ICP filter now runs at the EVENT level (on the name), not per-attendee.
    icpMatch = false;
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedIcp).toBe(1); // one EVENT dropped (not per-attendee)
    expect(enqueued).toHaveLength(0); // no rejected rows persisted
    expect(sdkCalls.webRead).toBe(0); // gated before any webRead spend
    expect(sdkCalls.findEmail).toBe(0);
  });

  it("drops attendees that shouldSkipFindEmail rejects (handle-looking name, blocked domain)", async () => {
    shouldSkipFindEmailResult = { ok: false, reason: "handle-looking" };
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(2);
    expect(sdkCalls.findEmail).toBe(0);
  });

  it("drops attendees whose verifyEmail says undeliverable", async () => {
    verifyDeliverable = false;
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(2);
    expect(sdkCalls.verifyEmail).toBe(2);
  });
});

describe("runLumaFinder — error resilience", () => {
  it("swallows a webRead throw for one event and still processes the others", async () => {
    event("https://luma.com/good");
    event("https://luma.com/bad");
    webReadThrowsForUrl.add("https://luma.com/bad");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(2); // both attendees of /good still enqueued
  });
});

describe("runLumaFinder — limits", () => {
  it("respects the enqueue limit across events", async () => {
    // 3 events × 2 attendees = 6 candidates; cap to 4.
    event("https://luma.com/e1");
    event("https://luma.com/e2");
    event("https://luma.com/e3");
    const out = await runLumaFinder({ ...baseConfig, limit: 4 });
    expect(out.enqueued).toBe(4);
  });

  it("dry-run mode short-circuits enqueue (counts as enqueued but no SDK fan-out)", async () => {
    event("https://luma.com/abc");
    const out = await runLumaFinder({ ...baseConfig, dryRun: true });
    expect(out.enqueued).toBe(2);
    expect(sdkCalls.findEmail).toBe(0);
    expect(sdkCalls.verifyEmail).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("runLumaFinder — auth mode (LUMA_SESSION_COOKIE)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalCookieEnv: string | undefined;
  let fetchCalls: Array<{ url: string; cookie: string }> = [];

  function stubFetch(responses: Array<{ status: number; body?: unknown; throws?: Error }>): void {
    let i = 0;
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        cookie: (init?.headers as Record<string, string> | undefined)?.["Cookie"] ?? "",
      });
      const r = responses[i++];
      if (!r) throw new Error("no more responses queued");
      if (r.throws) throw r.throws;
      return new Response(r.body != null ? JSON.stringify(r.body) : null, {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCookieEnv = process.env["LUMA_SESSION_COOKIE"];
    fetchCalls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCookieEnv == null) delete process.env["LUMA_SESSION_COOKIE"];
    else process.env["LUMA_SESSION_COOKIE"] = originalCookieEnv;
  });

  it("with cookie unset, fetch is never called and public-only path runs (regression)", async () => {
    delete process.env["LUMA_SESSION_COOKIE"];
    // Stub fetch anyway — if anything calls it, we'd see calls > 0.
    stubFetch([]);
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(fetchCalls).toHaveLength(0);
    expect(out.enqueued).toBe(2);
  });

  it("with cookie set + 200 OK, merges auth'd guests into the public list", async () => {
    process.env["LUMA_SESSION_COOKIE"] = "test-cookie";
    stubFetch([
      {
        status: 200,
        body: {
          entries: [
            { user: { name: "Carol", website: "https://carol.dev" } },
            { user: { name: "Dan", website: "https://dan.dev" } },
            { user: { name: "Eve", website: "https://eve.dev" } },
          ],
        },
      },
    ]);
    // Public extract: Alice + Bob. Auth'd: Carol/Dan/Eve. Merge: 5 unique.
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://api.lu.ma/event/admin/get-guest-list?event_api_id=abc",
    );
    expect(fetchCalls[0]?.cookie).toBe("luma.auth-session-key=test-cookie");
    // 2 public + 3 auth'd = 5 unique attendees → 5 enqueued.
    expect(out.enqueued).toBe(5);
  });

  it("falls back to public-only on 401 (expired cookie)", async () => {
    process.env["LUMA_SESSION_COOKIE"] = "expired";
    stubFetch([{ status: 401 }]);
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(2); // only the 2 public attendees
  });

  it("falls back to public-only when both candidate endpoints 404", async () => {
    process.env["LUMA_SESSION_COOKIE"] = "test-cookie";
    stubFetch([{ status: 404 }, { status: 404 }]);
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(fetchCalls).toHaveLength(2);
    expect(out.enqueued).toBe(2);
  });

  it("uses the bare endpoint after 404 on /admin/", async () => {
    process.env["LUMA_SESSION_COOKIE"] = "test-cookie";
    stubFetch([
      { status: 404 },
      {
        status: 200,
        body: { entries: [{ user: { name: "Carol", website: "https://carol.dev" } }] },
      },
    ]);
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toBe("https://api.lu.ma/event/get-guest-list?event_api_id=abc");
    expect(out.enqueued).toBe(3); // 2 public + 1 auth'd
  });

  it("falls back to public-only when fetch throws (network blip)", async () => {
    process.env["LUMA_SESSION_COOKIE"] = "test-cookie";
    stubFetch([
      { status: 0, throws: new Error("ECONNRESET") },
      { status: 0, throws: new Error("ECONNRESET") },
    ]);
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    expect(out.enqueued).toBe(2);
  });

  it("auth'd attendee dedupes against public one with the same name", async () => {
    process.env["LUMA_SESSION_COOKIE"] = "test-cookie";
    // Auth surfaces "Alice" again — same person, should NOT double-enqueue.
    stubFetch([
      {
        status: 200,
        body: {
          entries: [
            { user: { name: "Alice", website: "https://alice.dev" } },
            { user: { name: "Carol", website: "https://carol.dev" } },
          ],
        },
      },
    ]);
    event("https://luma.com/abc");
    const out = await runLumaFinder(baseConfig);
    // Public: Alice + Bob. Auth'd: Alice + Carol. Merged unique: Alice + Bob + Carol = 3.
    expect(out.enqueued).toBe(3);
  });
});
