import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLinkedinUrl,
  buildTwitterUrl,
  fetchAuthedGuestList,
  mergeAttendees,
} from "../src/_luma-auth.ts";

// Globally stub logEvent so test runs don't write to events.jsonl.
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {} };
});

const COOKIE = "usr-test.session-value-40-chars-0123456";
const SLUG = "evt-abc123";

interface FetchSpyCall {
  url: string;
  cookie: string;
}

function makeFetch(responses: Array<{ status: number; body?: unknown; throws?: Error }>): {
  fn: typeof globalThis.fetch;
  calls: FetchSpyCall[];
} {
  const calls: FetchSpyCall[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
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
  return { fn, calls };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchAuthedGuestList — short-circuit cases", () => {
  it("returns null when cookie is empty (never calls fetch)", async () => {
    const { fn, calls } = makeFetch([]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, "");
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when slug is empty (never calls fetch)", async () => {
    const { fn, calls } = makeFetch([]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList("", COOKIE);
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("fetchAuthedGuestList — request shape", () => {
  it("hits the /admin/ endpoint first, with the right cookie + slug query", async () => {
    const { fn, calls } = makeFetch([
      { status: 200, body: { entries: [{ user: { name: "Alice" } }] } },
    ]);
    globalThis.fetch = fn;
    await fetchAuthedGuestList(SLUG, COOKIE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.lu.ma/event/admin/get-guest-list?event_api_id=${SLUG}`);
    expect(calls[0]?.cookie).toBe(`luma.auth-session-key=${COOKIE}`);
  });

  it("falls back to the bare endpoint after 404 on /admin/", async () => {
    const { fn, calls } = makeFetch([
      { status: 404 },
      { status: 200, body: { entries: [{ user: { name: "Bob" } }] } },
    ]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, COOKIE);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toMatch(/\/admin\//);
    expect(calls[1]?.url).toBe(`https://api.lu.ma/event/get-guest-list?event_api_id=${SLUG}`);
    expect(out?.[0]?.name).toBe("Bob");
  });
});

describe("fetchAuthedGuestList — response handling", () => {
  it("parses entries[].user → LumaPublicAttendee with linkedin/twitter URL synthesis", async () => {
    const { fn } = makeFetch([
      {
        status: 200,
        body: {
          entries: [
            {
              user: {
                name: "Sarah Chen",
                bio_short: "Founder @ AcmeAI",
                website: "https://sarah.dev",
                linkedin_handle: "sarahchen",
                twitter_handle: "@schen",
                url: "https://luma.com/user/sarah-chen",
              },
              role: "Speaker",
            },
          ],
        },
      },
    ]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, COOKIE);
    expect(out).toHaveLength(1);
    expect(out?.[0]).toEqual({
      name: "Sarah Chen",
      profileUrl: "https://luma.com/user/sarah-chen",
      websiteUrl: "https://sarah.dev",
      linkedinUrl: "https://www.linkedin.com/in/sarahchen",
      twitterUrl: "https://x.com/schen",
      bio: "Founder @ AcmeAI",
      role: "Speaker",
    });
  });

  it("falls back to the `guests` array shape when `entries` is absent", async () => {
    const { fn } = makeFetch([{ status: 200, body: { guests: [{ user: { name: "Pat" } }] } }]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, COOKIE);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.name).toBe("Pat");
  });

  it("returns null on 401 (expired cookie) without retrying", async () => {
    const { fn, calls } = makeFetch([{ status: 401 }]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, COOKIE);
    expect(out).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null on 403 without retrying", async () => {
    const { fn } = makeFetch([{ status: 403 }]);
    globalThis.fetch = fn;
    expect(await fetchAuthedGuestList(SLUG, COOKIE)).toBeNull();
  });

  it("returns null when both endpoints return 404", async () => {
    const { fn, calls } = makeFetch([{ status: 404 }, { status: 404 }]);
    globalThis.fetch = fn;
    expect(await fetchAuthedGuestList(SLUG, COOKIE)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("returns null when response is 200 but not a known shape", async () => {
    const { fn } = makeFetch([{ status: 200, body: { weird: "shape" } }]);
    globalThis.fetch = fn;
    expect(await fetchAuthedGuestList(SLUG, COOKIE)).toBeNull();
  });

  it("returns null when JSON parse fails", async () => {
    // Raw fetch with a non-JSON body.
    const fn = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fn;
    expect(await fetchAuthedGuestList(SLUG, COOKIE)).toBeNull();
  });

  it("returns null when fetch throws on both endpoints (network blip)", async () => {
    const { fn } = makeFetch([
      { status: 0, throws: new Error("ECONNRESET") },
      { status: 0, throws: new Error("ECONNRESET") },
    ]);
    globalThis.fetch = fn;
    expect(await fetchAuthedGuestList(SLUG, COOKIE)).toBeNull();
  });

  it("caps at 30 attendees even when the API returns more", async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ user: { name: `User ${i}` } }));
    const { fn } = makeFetch([{ status: 200, body: { entries: big } }]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, COOKIE);
    expect(out).toHaveLength(30);
  });

  it("skips entries with no usable name", async () => {
    const { fn } = makeFetch([
      {
        status: 200,
        body: {
          entries: [{ user: { name: "" } }, { user: null }, {}, { user: { name: "Real Person" } }],
        },
      },
    ]);
    globalThis.fetch = fn;
    const out = await fetchAuthedGuestList(SLUG, COOKIE);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.name).toBe("Real Person");
  });
});

describe("buildLinkedinUrl", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["sarah", "https://www.linkedin.com/in/sarah"],
    ["@sarah", "https://www.linkedin.com/in/sarah"],
    ["https://linkedin.com/in/sarah", "https://linkedin.com/in/sarah"],
    ["https://www.linkedin.com/in/sarah", "https://www.linkedin.com/in/sarah"],
    // No-scheme variants previously double-prefixed — now stripped correctly.
    ["linkedin.com/in/sarah", "https://www.linkedin.com/in/sarah"],
    ["www.linkedin.com/in/sarah", "https://www.linkedin.com/in/sarah"],
    // Bare-path shape returned by api.lu.ma's linkedin_handle field.
    ["/in/sarah", "https://www.linkedin.com/in/sarah"],
    ["in/sarah", "https://www.linkedin.com/in/sarah"],
    ["/sarah", "https://www.linkedin.com/in/sarah"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(buildLinkedinUrl(input)).toBe(expected);
    });
  }
});

describe("buildTwitterUrl", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    [null, null],
    ["", null],
    ["schen", "https://x.com/schen"],
    ["@schen", "https://x.com/schen"],
    ["https://x.com/schen", "https://x.com/schen"],
    ["x.com/schen", "https://x.com/schen"],
    ["twitter.com/schen", "https://x.com/schen"],
    ["www.twitter.com/schen", "https://x.com/schen"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(buildTwitterUrl(input)).toBe(expected);
    });
  }
});

describe("mergeAttendees", () => {
  it("dedupes by lowercased name; auth wins on collision", () => {
    const pub = [
      {
        name: "Sarah Chen",
        profileUrl: null,
        websiteUrl: null,
        linkedinUrl: null,
        twitterUrl: null,
        bio: "from public",
        role: null,
      },
    ];
    const authed = [
      {
        name: "sarah chen", // different casing
        profileUrl: "https://luma.com/user/sarah-chen",
        websiteUrl: null,
        linkedinUrl: "https://www.linkedin.com/in/sc",
        twitterUrl: null,
        bio: "from auth",
        role: "Speaker",
      },
    ];
    const out = mergeAttendees(pub, authed);
    expect(out).toHaveLength(1);
    expect(out[0]?.bio).toBe("from auth");
    expect(out[0]?.role).toBe("Speaker");
    expect(out[0]?.linkedinUrl).toBe("https://www.linkedin.com/in/sc");
  });

  it("preserves both when names differ", () => {
    const pub = [
      {
        name: "Alice",
        profileUrl: null,
        websiteUrl: null,
        linkedinUrl: null,
        twitterUrl: null,
        bio: null,
        role: null,
      },
    ];
    const authed = [
      {
        name: "Bob",
        profileUrl: null,
        websiteUrl: null,
        linkedinUrl: null,
        twitterUrl: null,
        bio: null,
        role: null,
      },
    ];
    const out = mergeAttendees(pub, authed);
    expect(out.map((a) => a.name).toSorted()).toEqual(["Alice", "Bob"]);
  });

  it("per-field union: public fills nulls auth left empty (auth wins on conflict)", () => {
    const pub = [
      {
        name: "Sarah Chen",
        profileUrl: null,
        websiteUrl: "https://sarah.dev",
        linkedinUrl: "https://www.linkedin.com/in/sarahchen-from-public",
        twitterUrl: null,
        bio: "from public bio",
        role: "Going",
      },
    ];
    const authed = [
      {
        name: "Sarah Chen",
        profileUrl: "https://luma.com/user/sarah-chen",
        websiteUrl: null, // auth doesn't surface — should be filled from public
        linkedinUrl: null, // auth doesn't surface — should be filled from public
        twitterUrl: "https://x.com/schen", // auth has it; should win
        bio: "from auth bio", // auth has it; should win
        role: "Speaker", // auth has it; should win
      },
    ];
    const out = mergeAttendees(pub, authed);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: "Sarah Chen",
      profileUrl: "https://luma.com/user/sarah-chen", // only auth had it
      websiteUrl: "https://sarah.dev", // filled from public
      linkedinUrl: "https://www.linkedin.com/in/sarahchen-from-public", // filled from public
      twitterUrl: "https://x.com/schen", // auth wins
      bio: "from auth bio", // auth wins
      role: "Speaker", // auth wins
    });
  });

  it("ignores empty-name entries", () => {
    const out = mergeAttendees(
      [
        {
          name: "",
          profileUrl: null,
          websiteUrl: null,
          linkedinUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
      ],
      [
        {
          name: "  ",
          profileUrl: null,
          websiteUrl: null,
          linkedinUrl: null,
          twitterUrl: null,
          bio: null,
          role: null,
        },
      ],
    );
    expect(out).toHaveLength(0);
  });
});
