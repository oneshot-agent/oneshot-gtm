import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isoDateNDaysAgo,
  parseSearchItem,
  searchTopicRepos,
} from "../src/_github-search.ts";

const realFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  // The explicit `(input: unknown)` param widens vi.fn's inferred `calls`
  // tuple from `[]` to `[unknown]`, so `fn.mock.calls[0]?.[0]` typechecks.
  const fn = vi.fn(async (_input: unknown) => {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchThrows(message: string) {
  const fn = vi.fn(async (_input: unknown) => {
    throw new Error(message);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("isoDateNDaysAgo", () => {
  it("returns YYYY-MM-DD format", () => {
    const out = isoDateNDaysAgo(7, new Date(2026, 3, 25, 12, 0, 0));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("subtracts days correctly", () => {
    // Apr 25, 2026 minus 90 days = Jan 25, 2026
    const out = isoDateNDaysAgo(90, new Date(Date.UTC(2026, 3, 25, 12, 0, 0)));
    expect(out).toBe("2026-01-25");
  });
});

describe("parseSearchItem", () => {
  it("parses a well-formed item", () => {
    const out = parseSearchItem({
      html_url: "https://github.com/ada/agent",
      full_name: "ada/agent",
      description: "An agent stitching langchain + twilio",
      stargazers_count: 42,
      topics: ["llm-agents", "langchain"],
      language: "Python",
      pushed_at: "2026-04-20T10:00:00Z",
    });
    expect(out).toEqual({
      url: "https://github.com/ada/agent",
      fullName: "ada/agent",
      description: "An agent stitching langchain + twilio",
      stars: 42,
      topics: ["llm-agents", "langchain"],
      language: "Python",
      pushedAt: "2026-04-20T10:00:00Z",
    });
  });

  it("returns null when html_url is missing", () => {
    expect(parseSearchItem({ full_name: "ada/agent" })).toBeNull();
  });

  it("returns null when full_name is missing", () => {
    expect(parseSearchItem({ html_url: "https://github.com/ada/agent" })).toBeNull();
  });

  it("defaults stars to 0 when missing", () => {
    const out = parseSearchItem({
      html_url: "https://github.com/ada/agent",
      full_name: "ada/agent",
    });
    expect(out?.stars).toBe(0);
  });

  it("filters non-string entries from topics array", () => {
    const out = parseSearchItem({
      html_url: "https://github.com/ada/agent",
      full_name: "ada/agent",
      topics: ["llm-agents", 42, null, "langchain"],
    });
    expect(out?.topics).toEqual(["llm-agents", "langchain"]);
  });

  it("treats non-array topics as empty", () => {
    const out = parseSearchItem({
      html_url: "https://github.com/ada/agent",
      full_name: "ada/agent",
      topics: "not-an-array",
    });
    expect(out?.topics).toEqual([]);
  });
});

describe("searchTopicRepos", () => {
  const baseArgs = { topic: "llm-agents", minStars: 10, pushedSinceIso: "2026-01-25", perPage: 50 };

  it("builds the GitHub Search URL with topic / stars / pushed query operators", async () => {
    const fn = mockFetchOnce(200, { items: [] });
    await searchTopicRepos(baseArgs);
    expect(fn).toHaveBeenCalledTimes(1);
    const url = (fn.mock.calls[0]?.[0] ?? "") as string;
    // The query string is URL-encoded; decode for assertion clarity.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("topic:llm-agents");
    expect(decoded).toContain("stars:>=10");
    expect(decoded).toContain("pushed:>=2026-01-25");
    expect(decoded).toContain("sort=updated");
    expect(decoded).toContain("order=desc");
    expect(decoded).toContain("per_page=50");
  });

  it("URL-encodes topic names with special chars (defense)", async () => {
    const fn = mockFetchOnce(200, { items: [] });
    await searchTopicRepos({ ...baseArgs, topic: "ai agent" });
    const url = (fn.mock.calls[0]?.[0] ?? "") as string;
    expect(url).toContain("ai%20agent");
  });

  it("clamps perPage to [1, 100]", async () => {
    const fn = mockFetchOnce(200, { items: [] });
    await searchTopicRepos({ ...baseArgs, perPage: 999 });
    const url = (fn.mock.calls[0]?.[0] ?? "") as string;
    expect(url).toContain("per_page=100");
  });

  it("parses items[] into typed repos", async () => {
    mockFetchOnce(200, {
      items: [
        {
          html_url: "https://github.com/ada/agent",
          full_name: "ada/agent",
          description: "An agent",
          stargazers_count: 100,
          topics: ["llm-agents"],
          language: "Python",
          pushed_at: "2026-04-01T00:00:00Z",
        },
        {
          html_url: "https://github.com/bob/bot",
          full_name: "bob/bot",
          description: null,
          stargazers_count: 50,
          topics: [],
          language: null,
          pushed_at: "2026-03-15T00:00:00Z",
        },
      ],
    });
    const out = await searchTopicRepos(baseArgs);
    expect(out).toHaveLength(2);
    expect(out[0]?.fullName).toBe("ada/agent");
    expect(out[1]?.fullName).toBe("bob/bot");
    expect(out[1]?.description).toBeNull();
  });

  it("drops items missing required fields rather than throwing", async () => {
    mockFetchOnce(200, {
      items: [
        { html_url: "https://github.com/ada/agent", full_name: "ada/agent" }, // OK
        { html_url: "https://github.com/no/name" }, // missing full_name → dropped
        { full_name: "no/url" }, // missing html_url → dropped
      ],
    });
    const out = await searchTopicRepos(baseArgs);
    expect(out).toHaveLength(1);
    expect(out[0]?.fullName).toBe("ada/agent");
  });

  it("returns [] on 422 (invalid query)", async () => {
    mockFetchOnce(422, { message: "Validation Failed" });
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });

  it("returns [] on 403 (rate-limited)", async () => {
    mockFetchOnce(403, { message: "API rate limit exceeded" });
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });

  it("returns [] on 429", async () => {
    mockFetchOnce(429, "");
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });

  it("returns [] on 404", async () => {
    mockFetchOnce(404, { message: "Not Found" });
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });

  it("returns [] on network throw", async () => {
    mockFetchThrows("ECONNRESET");
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });

  it("returns [] on malformed JSON", async () => {
    mockFetchOnce(200, "not-json{");
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });

  it("returns [] when items is missing entirely", async () => {
    mockFetchOnce(200, { something_else: true });
    const out = await searchTopicRepos(baseArgs);
    expect(out).toEqual([]);
  });
});
