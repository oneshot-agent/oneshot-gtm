import { beforeEach, describe, expect, it, vi } from "vitest";

let nextResults: Array<{ url: string; title: string; description: string }> = [];
let nextCost = 0.01;
let throwOnSearch = false;
/** Message the mocked webSearch throws — drives the transient-vs-genuine branch. */
let searchErrorMessage = "simulated network error";
const calls = { webSearch: 0, queries: [] as string[] };

/** In-memory stand-in for the persistent linkedin_lookup_cache table. */
const persisted = new Map<string, { url: string | null; status: string; fetched_at: string }>();

vi.mock("@oneshot-gtm/core", () => ({
  webSearch: async (input: { query: string }) => {
    calls.webSearch++;
    calls.queries.push(input.query);
    if (throwOnSearch) throw new Error(searchErrorMessage);
    return {
      result: { results: nextResults, cost: nextCost },
      receiptId: 0,
    };
  },
  logEvent: () => {},
  // Real implementation — the transient/genuine split is the behaviour under
  // test, so mocking it would defeat the purpose.
  isTransientToolError: (err: unknown) => {
    const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
    return msg.includes("timed out") || msg.includes("rate limit") || /\b(50[0-9]|429)\b/.test(msg);
  },
  LINKEDIN_CACHE_TTL_MS: 30 * 24 * 3600 * 1000,
  LINKEDIN_MISS_TTL_MS: 14 * 24 * 3600 * 1000,
  getLedger: () => ({
    getCachedLinkedIn: (key: string) => persisted.get(key) ?? null,
    setCachedLinkedIn: (key: string, url: string | null) => {
      persisted.set(key, {
        url,
        status: url ? "hit" : "miss",
        fetched_at: new Date().toISOString(),
      });
    },
  }),
}));

const {
  _resetLinkedInCache,
  extractFirstPhone,
  findLinkedInUrl,
  isLinkedInProfileUrl,
  looksLikeOrgName,
  nameMatchesTitle,
} = await import("../src/_linkedin.ts");
const { _resetBreaker } = await import("../src/_breaker.ts");

function reset(): void {
  _resetLinkedInCache();
  persisted.clear();
  _resetBreaker();
  calls.webSearch = 0;
  calls.queries = [];
  nextResults = [];
  nextCost = 0.01;
  throwOnSearch = false;
  searchErrorMessage = "simulated network error";
}

describe("findLinkedInUrl", () => {
  beforeEach(reset);

  it("returns the first URL matching linkedin.com/in/<slug>", async () => {
    nextResults = [
      { url: "https://example.com/blog", title: "", description: "" },
      { url: "https://www.linkedin.com/in/alice-smith", title: "", description: "" },
      { url: "https://www.linkedin.com/in/bob", title: "", description: "" },
    ];
    let cost = 0;
    const url = await findLinkedInUrl({
      fullName: "Alice Smith",
      disambiguators: ["Acme Inc"],
      accumCost: (c) => {
        cost += c ?? 0;
      },
      errKindPrefix: "test",
    });
    expect(url).toBe("https://www.linkedin.com/in/alice-smith");
    expect(cost).toBeCloseTo(0.01, 5);
    expect(calls.webSearch).toBe(1);
    expect(calls.queries[0]).toBe('"Alice Smith" "Acme Inc" site:linkedin.com/in');
  });

  it("returns null when no result URL matches the LinkedIn-profile shape", async () => {
    nextResults = [
      { url: "https://www.linkedin.com/company/acme", title: "", description: "" },
      { url: "https://www.linkedin.com/jobs/123", title: "", description: "" },
    ];
    const url = await findLinkedInUrl({
      fullName: "Alice Smith",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBeNull();
  });

  it("returns null on empty fullName without calling webSearch", async () => {
    const url = await findLinkedInUrl({
      fullName: "  ",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBeNull();
    expect(calls.webSearch).toBe(0);
  });

  it("matches case-insensitive host (uppercase LinkedIn URL)", async () => {
    nextResults = [{ url: "HTTPS://LINKEDIN.COM/in/alice", title: "", description: "" }];
    const url = await findLinkedInUrl({
      fullName: "Alice",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBe("HTTPS://LINKEDIN.COM/in/alice");
  });

  it("matches URL-encoded slugs (non-Latin display names)", async () => {
    nextResults = [
      {
        url: "https://www.linkedin.com/in/%E7%8E%8B%E5%B0%8F%E6%98%8E",
        title: "",
        description: "",
      },
    ];
    const url = await findLinkedInUrl({
      fullName: "王小明",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBe("https://www.linkedin.com/in/%E7%8E%8B%E5%B0%8F%E6%98%8E");
  });

  it("rejects /company/ and /jobs/ URLs", async () => {
    nextResults = [
      { url: "https://www.linkedin.com/company/acme", title: "", description: "" },
      { url: "https://www.linkedin.com/posts/alice_activity-123", title: "", description: "" },
    ];
    const url = await findLinkedInUrl({
      fullName: "Alice",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBeNull();
  });

  it("caches per (fullName, disambiguators); duplicate call doesn't re-fetch", async () => {
    nextResults = [{ url: "https://www.linkedin.com/in/alice", title: "", description: "" }];
    const args = {
      fullName: "Alice Smith",
      disambiguators: ["Acme"],
      accumCost: () => {},
      errKindPrefix: "test",
    };
    const u1 = await findLinkedInUrl(args);
    const u2 = await findLinkedInUrl(args);
    expect(u1).toBe(u2);
    expect(calls.webSearch).toBe(1);
  });

  it("caches null misses too", async () => {
    nextResults = [];
    const args = {
      fullName: "Nobody Special",
      accumCost: () => {},
      errKindPrefix: "test",
    };
    const u1 = await findLinkedInUrl(args);
    const u2 = await findLinkedInUrl(args);
    expect(u1).toBeNull();
    expect(u2).toBeNull();
    expect(calls.webSearch).toBe(1);
  });

  it("returns null + swallows the error when webSearch throws", async () => {
    throwOnSearch = true;
    const url = await findLinkedInUrl({
      fullName: "Alice",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBeNull();
  });
});

describe("findLinkedInUrl — built-in name verification", () => {
  beforeEach(reset);

  it("skips a result whose title names someone else and takes the next", async () => {
    // Every finder gets this for free — a wrong URL here becomes outreach to a
    // stranger, not a blank field.
    nextResults = [
      {
        url: "https://ph.linkedin.com/in/menchie-chua-uy",
        title: "Menchie Chua Uy - Bluelambda | LinkedIn",
        description: "",
      },
      {
        url: "https://www.linkedin.com/in/fteo",
        title: "Francis Teo - Bluelambda | LinkedIn",
        description: "",
      },
    ];
    const mismatches: string[] = [];
    const url = await findLinkedInUrl({
      fullName: "Francis Teo",
      accumCost: () => {},
      errKindPrefix: "test",
      onTitleMismatch: (r) => mismatches.push(r.url),
    });
    expect(url).toBe("https://www.linkedin.com/in/fteo");
    expect(mismatches).toEqual(["https://ph.linkedin.com/in/menchie-chua-uy"]);
  });

  it("accepts a vanity slug when the title confirms the person", async () => {
    // The whole reason the check reads the title and not the URL.
    nextResults = [
      {
        url: "https://il.linkedin.com/in/hackingonstuff",
        title: "Elad Ben-Israel - Wing | LinkedIn",
        description: "",
      },
    ];
    const url = await findLinkedInUrl({
      fullName: "Elad Ben-Israel",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBe("https://il.linkedin.com/in/hackingonstuff");
  });

  it("does not search an org name at all", async () => {
    const url = await findLinkedInUrl({
      fullName: "ByteDance Inc.",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBeNull();
    expect(calls.webSearch).toBe(0); // free, not just wrong
  });

  it("still accepts when the name is a bare handle it cannot verify", async () => {
    // Finders pass a GitHub handle when that's all they have. The check has no
    // verdict there, so it must not turn every handle lookup into a miss.
    nextResults = [
      { url: "https://www.linkedin.com/in/someone", title: "Some One - Acme", description: "" },
    ];
    const url = await findLinkedInUrl({
      fullName: "yijin840",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBe("https://www.linkedin.com/in/someone");
  });
});

describe("findLinkedInUrl — persistent cache", () => {
  beforeEach(reset);

  const lookup = (fullName: string): Promise<string | null> =>
    findLinkedInUrl({ fullName, accumCost: () => {}, errKindPrefix: "test" });

  it("serves a hit from the persistent cache across process restarts", async () => {
    nextResults = [{ url: "https://www.linkedin.com/in/alice", title: "", description: "" }];
    expect(await lookup("Alice")).toBe("https://www.linkedin.com/in/alice");
    expect(calls.webSearch).toBe(1);

    // Simulate a restart: the in-process memo is gone, the table is not.
    _resetLinkedInCache();
    expect(await lookup("Alice")).toBe("https://www.linkedin.com/in/alice");
    expect(calls.webSearch).toBe(1); // no second $0.01 search
  });

  it("serves a genuine miss from the persistent cache too", async () => {
    nextResults = [{ url: "https://example.com/nope", title: "", description: "" }];
    expect(await lookup("Ghost")).toBeNull();
    expect(calls.webSearch).toBe(1);

    _resetLinkedInCache();
    expect(await lookup("Ghost")).toBeNull();
    expect(calls.webSearch).toBe(1); // a miss is a real answer — don't re-pay
  });

  it("does NOT persist a transient failure — it would poison the cache for weeks", async () => {
    throwOnSearch = true;
    searchErrorMessage = "request timed out";
    expect(await lookup("Alice")).toBeNull();
    expect(persisted.size).toBe(0);

    // Platform recovers: the next run must search again rather than serve a
    // cached miss.
    _resetLinkedInCache();
    _resetBreaker();
    throwOnSearch = false;
    nextResults = [{ url: "https://www.linkedin.com/in/alice", title: "", description: "" }];
    expect(await lookup("Alice")).toBe("https://www.linkedin.com/in/alice");
    expect(calls.webSearch).toBe(2);
  });

  it("DOES persist a genuine (non-transient) failure", async () => {
    throwOnSearch = true;
    searchErrorMessage = "malformed query";
    expect(await lookup("Alice")).toBeNull();
    expect(persisted.size).toBe(1);
  });

  it("ignores an expired cache entry and searches again", async () => {
    const stale = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    persisted.set(JSON.stringify(["alice", []]), {
      url: "https://www.linkedin.com/in/old",
      status: "hit",
      fetched_at: stale,
    });
    nextResults = [{ url: "https://www.linkedin.com/in/fresh", title: "", description: "" }];
    expect(await lookup("Alice")).toBe("https://www.linkedin.com/in/fresh");
    expect(calls.webSearch).toBe(1);
  });
});

describe("findLinkedInUrl — circuit breaker", () => {
  beforeEach(reset);

  it("stops spending once the breaker trips", async () => {
    throwOnSearch = true;
    searchErrorMessage = "rate limit exceeded"; // transient → trips the breaker
    // THRESHOLD is 5 consecutive platform errors.
    for (let i = 0; i < 5; i++) {
      await findLinkedInUrl({
        fullName: `Person ${i}`,
        accumCost: () => {},
        errKindPrefix: "test",
      });
    }
    expect(calls.webSearch).toBe(5);

    // Breaker now open: further candidates short-circuit without a paid call.
    const url = await findLinkedInUrl({
      fullName: "Person 99",
      accumCost: () => {},
      errKindPrefix: "test",
    });
    expect(url).toBeNull();
    expect(calls.webSearch).toBe(5);
  });
});

describe("extractFirstPhone", () => {
  it("reads deepResearch enrichment.fullphone[0].fullphone shape", () => {
    const enrichment = {
      fullphone: [{ fullphone: "+15551234567" }, { fullphone: "+15557654321" }],
    };
    expect(extractFirstPhone(enrichment)).toBe("+15551234567");
  });

  it("reads enrichProfile profile.phone shape", () => {
    expect(extractFirstPhone({ phone: "+447700900123" })).toBe("+447700900123");
  });

  it("returns null on missing shapes", () => {
    expect(extractFirstPhone(null)).toBeNull();
    expect(extractFirstPhone(undefined)).toBeNull();
    expect(extractFirstPhone({})).toBeNull();
    expect(extractFirstPhone({ fullphone: [] })).toBeNull();
    expect(extractFirstPhone({ phone: "" })).toBeNull();
  });

  it("trims whitespace from the returned phone", () => {
    expect(extractFirstPhone({ phone: "  +12025551212  " })).toBe("+12025551212");
  });
});

describe("isLinkedInProfileUrl", () => {
  it("accepts canonical profile URLs", () => {
    expect(isLinkedInProfileUrl("https://www.linkedin.com/in/alice")).toBe(true);
    expect(isLinkedInProfileUrl("https://linkedin.com/in/alice-smith")).toBe(true);
    expect(isLinkedInProfileUrl("http://www.linkedin.com/in/bob")).toBe(true);
  });

  it("rejects non-profile LinkedIn URLs and garbage", () => {
    expect(isLinkedInProfileUrl("https://www.linkedin.com/company/acme")).toBe(false);
    expect(isLinkedInProfileUrl("https://www.linkedin.com/posts/alice_activity-1")).toBe(false);
    expect(isLinkedInProfileUrl("see their profile")).toBe(false);
    expect(isLinkedInProfileUrl("javascript:alert(1)")).toBe(false);
    expect(isLinkedInProfileUrl(null)).toBe(false);
    expect(isLinkedInProfileUrl(undefined)).toBe(false);
    expect(isLinkedInProfileUrl("")).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isLinkedInProfileUrl("  https://linkedin.com/in/alice  ")).toBe(true);
  });
});

describe("nameMatchesTitle", () => {
  it("accepts the vanity slugs an URL-based check wrongly rejected", () => {
    // Every one of these is a real profile the slug heuristic threw away. The
    // slug is member-chosen text; the title is LinkedIn's own display name.
    expect(nameMatchesTitle("Elad Ben-Israel - Wing | LinkedIn", "Elad Ben-Israel")).toBe(true);
    expect(nameMatchesTitle("Gaurav Tewari - Founder | LinkedIn", "Gaurav Tewari")).toBe(true);
    expect(nameMatchesTitle("Travis Fischer - Agentic | LinkedIn", "Travis Fischer")).toBe(true);
  });

  it("tolerates a middle name the profile omits", () => {
    expect(nameMatchesTitle("Bradley Kirton - Data Engineer", "Bradley Stuart Kirton")).toBe(true);
    expect(nameMatchesTitle("Navin Hill - CTO", "James Navin Hill")).toBe(true);
  });

  it("compares whole tokens, never substrings", () => {
    // Regression: "son" is a substring of "johnson" and "ann" of "joanne", so a
    // substring check accepted a complete stranger and cached their URL.
    expect(nameMatchesTitle("Joanne Johnson - Acme | LinkedIn", "Ann Son")).toBe(false);
    expect(nameMatchesTitle("Christopher Anderson", "Chris Ander")).toBe(false);
    // ...while a real match on the same shape still passes.
    expect(nameMatchesTitle("Ann Son - Acme | LinkedIn", "Ann Son")).toBe(true);
  });

  it("rejects a different person", () => {
    // This one really was wrong: searching "Francis Teo" returned Menchie Chua
    // Uy's profile, and writing it would put a connection request in front of
    // someone who never starred anything.
    expect(nameMatchesTitle("Menchie Chua Uy - Bluelambda", "Francis Teo")).toBe(false);
    expect(nameMatchesTitle("Tingting Zeng - ByteDance", "Greg Doig")).toBe(false);
  });

  it("requires the surname, not just any token", () => {
    // A shared first name is not evidence.
    expect(nameMatchesTitle("Greg Adams - Engineer", "Greg Doig")).toBe(false);
  });

  it("ignores accents and punctuation on both sides", () => {
    expect(nameMatchesTitle("Andres Cabero - Dev", "Andrés Cabero")).toBe(true);
    expect(nameMatchesTitle("Rafael K. Streit - Tripsy", "Rafael Streit")).toBe(true);
  });

  it("passes through when there is nothing to compare", () => {
    expect(nameMatchesTitle("", "Greg Doig")).toBe(true); // no title in the result
    expect(nameMatchesTitle("J. R. Smith", "J. R.")).toBe(true); // initials only
  });
});

describe("looksLikeOrgName", () => {
  it("catches the GitHub org accounts that produced wrong writes", () => {
    expect(looksLikeOrgName("ByteDance Inc.")).toBe(true);
    expect(looksLikeOrgName("Strategic Automation")).toBe(true);
    expect(looksLikeOrgName("Atomic Bot")).toBe(true);
    expect(looksLikeOrgName("Baur Software")).toBe(true);
  });

  it("leaves ordinary people alone", () => {
    expect(looksLikeOrgName("Greg Doig")).toBe(false);
    expect(looksLikeOrgName("Elad Ben-Israel")).toBe(false);
    expect(looksLikeOrgName(null)).toBe(false);
  });

  it("does not treat 'ai' or 'co' as org markers", () => {
    // Both collide with real given names — dropping a person is worse than the
    // rare org that slips through to a title check.
    expect(looksLikeOrgName("Ai Tanaka")).toBe(false);
    expect(looksLikeOrgName("Co Nguyen")).toBe(false);
  });
});
