import { beforeEach, describe, expect, it, vi } from "vitest";

let nextResults: Array<{ url: string; title: string; description: string }> = [];
let nextCost = 0.01;
let throwOnSearch = false;
const calls = { webSearch: 0, queries: [] as string[] };

vi.mock("@oneshot-gtm/core", () => ({
  webSearch: async (input: { query: string }) => {
    calls.webSearch++;
    calls.queries.push(input.query);
    if (throwOnSearch) throw new Error("simulated network error");
    return {
      result: { results: nextResults, cost: nextCost },
      receiptId: 0,
    };
  },
  logEvent: () => {},
}));

const { _resetLinkedInCache, extractFirstPhone, findLinkedInUrl, isLinkedInProfileUrl } =
  await import("../src/_linkedin.ts");

function reset(): void {
  _resetLinkedInCache();
  calls.webSearch = 0;
  calls.queries = [];
  nextResults = [];
  nextCost = 0.01;
  throwOnSearch = false;
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
      { url: "https://www.linkedin.com/in/%E7%8E%8B%E5%B0%8F%E6%98%8E", title: "", description: "" },
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
