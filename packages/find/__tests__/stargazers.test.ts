import { afterEach, describe, expect, it, vi } from "vitest";
import { recentStargazers } from "../src/_stargazers.ts";

function star(login: string, starredAt: string) {
  return { starred_at: starredAt, user: { login, html_url: `https://github.com/${login}` } };
}
function watchEvent(login: string, createdAt: string) {
  return { type: "WatchEvent", created_at: createdAt, actor: { login } };
}
function res(rows: unknown[], link: string | null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "link" ? link : null) },
    json: async () => rows,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("recentStargazers", () => {
  it("keeps only stars within the window (single page)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res([star("old", "2020-01-01T00:00:00Z"), star("fresh", "2026-06-01T00:00:00Z")], null),
      ),
    );
    const { stargazers, error, newestSeen } = await recentStargazers("o/r", {
      sinceIso: "2026-05-01T00:00:00Z",
    });
    expect(error).toBeUndefined();
    expect(stargazers.map((s) => s.login)).toEqual(["fresh"]);
    // newestSeen tracks the most-recent star regardless of the window.
    expect(newestSeen).toBe("2026-06-01T00:00:00Z");
  });

  it("surfaces a non-2xx on a backward page as an error (not a silent empty)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? "1");
      if (page === 1) {
        return res(
          [star("p1", "2020-01-01T00:00:00Z")],
          '<https://x?per_page=100&page=3>; rel="last"',
        );
      }
      // Backward page → rate-limited.
      return { ok: false, status: 403, headers: { get: () => null }, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await recentStargazers("o/r", { sinceIso: "2026-05-01T00:00:00Z" });
    expect(out.error).toMatch(/403/);
  });

  it("walks from the last page backward and stops once a page is all older", async () => {
    const byPage: Record<number, unknown[]> = {
      1: [star("p1", "2020-01-01T00:00:00Z")], // oldest
      2: [star("p2", "2020-02-01T00:00:00Z")], // still old
      3: [star("p3a", "2026-06-01T00:00:00Z"), star("p3b", "2026-06-02T00:00:00Z")], // newest
    };
    const fetchMock = vi.fn(async (url: string) => {
      // Require a ?/& delimiter so we don't match `per_page=100`.
      const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? "1");
      // Link (rel="last") is only read off the first request.
      return res(
        byPage[page] ?? [],
        page === 1 ? '<https://x?per_page=100&page=3>; rel="last"' : null,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { stargazers } = await recentStargazers("o/r", { sinceIso: "2026-05-01T00:00:00Z" });
    expect(stargazers.map((s) => s.login).toSorted()).toEqual(["p3a", "p3b"]);
    // page1 (for the Link header) + page3 (fresh) + page2 (all older → stop). page1 in-loop never reached.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns an error (not a throw) on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: async () => [],
      })),
    );
    const out = await recentStargazers("o/r", { sinceIso: "2026-01-01T00:00:00Z" });
    expect(out.error).toBeDefined();
    expect(out.stargazers).toEqual([]);
  });

  // July 2026: /stargazers is admin/collaborator-only for third-party repos.
  it("falls back to the events feed when the list endpoint is restricted", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/stargazers")) {
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => [] };
      }
      // events feed: newest-first, WatchEvents mixed with other event types
      return res(
        [
          watchEvent("fresh", "2026-06-02T00:00:00Z"),
          { type: "PushEvent", created_at: "2026-06-01T12:00:00Z", actor: { login: "pusher" } },
          watchEvent("fresh", "2026-06-01T00:00:00Z"), // dup login → deduped
          watchEvent("stale", "2020-01-01T00:00:00Z"), // outside window → newestSeen only
        ],
        null,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { stargazers, error, newestSeen } = await recentStargazers("o/r", {
      sinceIso: "2026-05-01T00:00:00Z",
    });
    expect(error).toBeUndefined();
    expect(stargazers.map((s) => s.login)).toEqual(["fresh"]);
    expect(stargazers[0]?.starredAt).toBe("2026-06-02T00:00:00Z");
    expect(newestSeen).toBe("2026-06-02T00:00:00Z");
    // one restricted /stargazers hit + one /events page (rows < 100 → stop)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces an error when both list and events endpoints fail", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: false,
      status: String(url).includes("/stargazers") ? 403 : 429,
      headers: { get: () => null },
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await recentStargazers("o/r", { sinceIso: "2026-01-01T00:00:00Z" });
    expect(out.error).toMatch(/events status 429/);
    expect(out.stargazers).toEqual([]);
  });

  it("stops paging events once a page's oldest event predates the window", async () => {
    const hundredEvents = Array.from({ length: 99 }, (_, i) => ({
      type: "PushEvent",
      created_at: "2026-06-01T00:00:00Z",
      actor: { login: `p${i}` },
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/stargazers")) {
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => [] };
      }
      // full page (100 rows) whose oldest row predates the window → no page 2
      return res([...hundredEvents, watchEvent("old", "2020-01-01T00:00:00Z")], null);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { stargazers } = await recentStargazers("o/r", { sinceIso: "2026-05-01T00:00:00Z" });
    expect(stargazers).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 stargazers + 1 events page only
  });
});
