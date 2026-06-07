import { afterEach, describe, expect, it, vi } from "vitest";
import { recentStargazers } from "../src/_stargazers.ts";

function star(login: string, starredAt: string) {
  return { starred_at: starredAt, user: { login, html_url: `https://github.com/${login}` } };
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
        return res([star("p1", "2020-01-01T00:00:00Z")], '<https://x?per_page=100&page=3>; rel="last"');
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
        status: 403,
        headers: { get: () => null },
        json: async () => [],
      })),
    );
    const out = await recentStargazers("o/r", { sinceIso: "2026-01-01T00:00:00Z" });
    expect(out.error).toBeDefined();
    expect(out.stargazers).toEqual([]);
  });
});
