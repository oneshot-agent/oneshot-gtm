import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGitHubUserCache,
  _resetTopReposCache,
  extractBlogDomain,
  fetchGitHubUser,
  fetchTopRepos,
  ownerFromRepoUrl,
} from "../src/_github-user.ts";

// vi.mock at module-level isn't enough — we want to swap the global fetch
// per-test so we can assert on call count and shape without bringing in MSW.
const realFetch = globalThis.fetch;

function mockFetchOnceJson(status: number, body: unknown) {
  const fn = vi.fn(async () => {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const next = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchThrows(message: string) {
  const fn = vi.fn(async () => {
    throw new Error(message);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  _resetGitHubUserCache();
  _resetTopReposCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("extractBlogDomain", () => {
  it("strips protocol, www, and trailing path/query", () => {
    expect(extractBlogDomain("https://www.acme.dev/about?utm=x")).toBe("acme.dev");
    expect(extractBlogDomain("http://acme.dev")).toBe("acme.dev");
  });

  it("schemes the bare domain when missing", () => {
    expect(extractBlogDomain("acme.dev")).toBe("acme.dev");
    expect(extractBlogDomain("acme.dev/about")).toBe("acme.dev");
  });

  it("returns null on empty / whitespace / non-string", () => {
    expect(extractBlogDomain("")).toBeNull();
    expect(extractBlogDomain("   ")).toBeNull();
    expect(extractBlogDomain(null)).toBeNull();
    expect(extractBlogDomain(undefined)).toBeNull();
    expect(extractBlogDomain(42)).toBeNull();
  });

  it("returns null on a hostname with no dot (not a public domain)", () => {
    expect(extractBlogDomain("localhost")).toBeNull();
    expect(extractBlogDomain("https://localhost:3000")).toBeNull();
  });

  it("lowercases the hostname", () => {
    expect(extractBlogDomain("https://Acme.DEV")).toBe("acme.dev");
  });
});

describe("ownerFromRepoUrl", () => {
  it("extracts the owner from a canonical github URL", () => {
    expect(ownerFromRepoUrl("https://github.com/acme/foo")).toBe("acme");
  });

  it("returns null for non-github hosts", () => {
    expect(ownerFromRepoUrl("https://gitlab.com/acme/foo")).toBeNull();
  });

  it("returns null for malformed urls", () => {
    expect(ownerFromRepoUrl("not a url")).toBeNull();
    expect(ownerFromRepoUrl("https://github.com/")).toBeNull();
  });
});

describe("fetchGitHubUser", () => {
  it("parses email and blog when both present", async () => {
    mockFetchOnceJson(200, {
      login: "ada",
      name: "Ada Lovelace",
      email: "ada@acme.dev",
      blog: "https://www.acme.dev/about",
      company: "@acme",
    });
    const out = await fetchGitHubUser("ada");
    expect(out).toEqual({
      login: "ada",
      name: "Ada Lovelace",
      email: "ada@acme.dev",
      blogDomain: "acme.dev",
      company: "@acme",
    });
  });

  it("returns null name when GitHub user hasn't set a display name", async () => {
    mockFetchOnceJson(200, { login: "ada", name: "", email: null, blog: "" });
    const out = await fetchGitHubUser("ada");
    expect(out?.name).toBeNull();
  });

  it("returns null email when GitHub gives an empty string (private)", async () => {
    mockFetchOnceJson(200, { login: "ada", email: "", blog: "acme.dev", company: null });
    const out = await fetchGitHubUser("ada");
    expect(out?.email).toBeNull();
    expect(out?.blogDomain).toBe("acme.dev");
  });

  it("returns null email AND blog when both are missing/empty", async () => {
    mockFetchOnceJson(200, { login: "ada", email: null, blog: "", company: null });
    const out = await fetchGitHubUser("ada");
    expect(out?.email).toBeNull();
    expect(out?.blogDomain).toBeNull();
    expect(out?.company).toBeNull();
  });

  it("returns null on 404", async () => {
    mockFetchOnceJson(404, { message: "Not Found" });
    const out = await fetchGitHubUser("nobody");
    expect(out).toBeNull();
  });

  it("returns null on 429 (rate-limited)", async () => {
    mockFetchOnceJson(429, "");
    const out = await fetchGitHubUser("ada");
    expect(out).toBeNull();
  });

  it("returns null on 403 (GitHub's actual unauth rate-limit signal)", async () => {
    mockFetchOnceJson(403, { message: "API rate limit exceeded" });
    const out = await fetchGitHubUser("ada");
    expect(out).toBeNull();
  });

  it("returns null on network throw", async () => {
    mockFetchThrows("ECONNRESET");
    const out = await fetchGitHubUser("ada");
    expect(out).toBeNull();
  });

  it("returns null on malformed JSON body", async () => {
    mockFetchOnceJson(200, "not-json{");
    const out = await fetchGitHubUser("ada");
    expect(out).toBeNull();
  });

  it("caches the second call (single fetch even across casing)", async () => {
    const fn = mockFetchOnceJson(200, { login: "Ada", email: "a@b.dev", blog: "" });
    await fetchGitHubUser("Ada");
    await fetchGitHubUser("ada");
    await fetchGitHubUser("ADA");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caches negative results too (no retry on a known 404 within the run)", async () => {
    const fn = mockFetchSequence([
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { login: "ada", email: "a@b.dev" } },
    ]);
    expect(await fetchGitHubUser("ada")).toBeNull();
    expect(await fetchGitHubUser("ada")).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("URL-encodes the login (defense against weird usernames)", async () => {
    const fn = mockFetchOnceJson(200, { login: "weird name" });
    await fetchGitHubUser("weird name");
    expect(fn).toHaveBeenCalledWith(
      "https://api.github.com/users/weird%20name",
      expect.any(Object),
    );
  });
});

describe("fetchTopRepos", () => {
  it("returns a 3-field shape (name/description/language), dropping noise fields", async () => {
    mockFetchOnceJson(200, [
      {
        name: "agent-loop",
        description: "self-rewriting skill loop for autonomous agents",
        language: "Python",
        stargazers_count: 42,
        forks_count: 3,
        pushed_at: "2026-05-01T00:00:00Z",
      },
      { name: "tiny-llm", description: null, language: "Rust" },
    ]);
    const out = await fetchTopRepos("ada");
    expect(out).toEqual([
      {
        name: "agent-loop",
        description: "self-rewriting skill loop for autonomous agents",
        language: "Python",
      },
      { name: "tiny-llm", description: null, language: "Rust" },
    ]);
  });

  it("hits the per_page=10&sort=pushed&type=owner endpoint", async () => {
    const fn = mockFetchOnceJson(200, []);
    await fetchTopRepos("ada");
    expect(fn).toHaveBeenCalledWith(
      "https://api.github.com/users/ada/repos?per_page=10&sort=pushed&type=owner",
      expect.any(Object),
    );
  });

  it("treats empty array as a real value (zero public repos != null)", async () => {
    mockFetchOnceJson(200, []);
    expect(await fetchTopRepos("ada")).toEqual([]);
  });

  it("filters out archived + forked + missing-name entries", async () => {
    // Regression guard for ultrareview bug_001. type=owner does NOT exclude
    // forks (it filters by ownership relation, not fork status) — a fork of
    // kubernetes the user owns would be returned and, with sort=pushed,
    // float to the top because forks track upstream pushes. Client-side
    // filter on r.fork drops them.
    mockFetchOnceJson(200, [
      { name: "live-repo", description: "still maintained", language: "Go", archived: false },
      { name: "old-thing", description: "shelved last year", language: "C", archived: true },
      { name: "kubernetes", description: "fork of upstream", language: "Go", fork: true },
      { name: "", description: "no name somehow", language: null },
      { description: "no name field at all", language: "JS" },
      { name: "another-live", description: null, language: null },
    ]);
    const out = await fetchTopRepos("ada");
    expect(out).toEqual([
      { name: "live-repo", description: "still maintained", language: "Go" },
      { name: "another-live", description: null, language: null },
    ]);
    // Explicit: the fork must not be in the output (the test above already
    // covers this transitively, but being explicit makes the intent obvious
    // for future readers).
    expect(out?.some((r) => r.name === "kubernetes")).toBe(false);
  });

  it("truncates descriptions over 160 chars with an ellipsis", async () => {
    const longDesc = "x".repeat(400);
    mockFetchOnceJson(200, [{ name: "wordy", description: longDesc, language: "MD" }]);
    const out = await fetchTopRepos("ada");
    expect(out).not.toBeNull();
    expect(out![0]!.description).toHaveLength(160);
    expect(out![0]!.description?.endsWith("…")).toBe(true);
  });

  it("returns null on 404 / 429 / 403 / non-array body", async () => {
    mockFetchOnceJson(404, { message: "Not Found" });
    expect(await fetchTopRepos("ada")).toBeNull();
    _resetTopReposCache();
    mockFetchOnceJson(429, "");
    expect(await fetchTopRepos("ada")).toBeNull();
    _resetTopReposCache();
    mockFetchOnceJson(403, { message: "rate limit" });
    expect(await fetchTopRepos("ada")).toBeNull();
    _resetTopReposCache();
    mockFetchOnceJson(200, { not: "an array" });
    expect(await fetchTopRepos("ada")).toBeNull();
  });

  it("returns null on network throw", async () => {
    mockFetchThrows("ECONNRESET");
    expect(await fetchTopRepos("ada")).toBeNull();
  });

  it("caches positive results across casing (single fetch)", async () => {
    const fn = mockFetchOnceJson(200, [{ name: "x", description: null, language: null }]);
    await fetchTopRepos("Ada");
    await fetchTopRepos("ada");
    await fetchTopRepos("ADA");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caches negative results too (no retry on a known 404 within the run)", async () => {
    const fn = mockFetchSequence([
      { status: 404, body: {} },
      { status: 200, body: [] },
    ]);
    expect(await fetchTopRepos("zed")).toBeNull();
    expect(await fetchTopRepos("zed")).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("URL-encodes the login", async () => {
    const fn = mockFetchOnceJson(200, []);
    await fetchTopRepos("weird name");
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("/users/weird%20name/repos"),
      expect.any(Object),
    );
  });
});
