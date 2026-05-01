import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGitHubUserCache,
  extractBlogDomain,
  fetchGitHubUser,
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
