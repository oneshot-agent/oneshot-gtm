import { logEvent } from "@oneshot-gtm/core";
import { githubHeaders } from "./_github-search.ts";

export interface Stargazer {
  login: string;
  userUrl: string;
  /** ISO timestamp of the star (from the star+json media type). */
  starredAt: string;
}

/** Parse one `application/vnd.github.star+json` stargazer row. */
function parseStarRow(raw: unknown): Stargazer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const starredAt = typeof r["starred_at"] === "string" ? (r["starred_at"] as string) : null;
  const user = r["user"];
  if (!starredAt || !user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  const login = typeof u["login"] === "string" ? (u["login"] as string) : null;
  if (!login) return null;
  const userUrl = typeof u["html_url"] === "string" ? (u["html_url"] as string) : null;
  return { login, userUrl: userUrl ?? `https://github.com/${login}`, starredAt };
}

/** Read the `page=N>; rel="last"` page number from a GitHub `Link` header. */
function parseLastPage(link: string | null): number {
  if (!link) return 1;
  const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  return m ? Math.max(1, Number.parseInt(m[1] ?? "1", 10)) : 1;
}

/**
 * Recent stargazers of a public repo. GitHub returns stargazers oldest-first,
 * so the newest stars live on the LAST page — we read the `Link: rel="last"`
 * page number, then page backward (newest → older), collecting stars with
 * `starredAt >= sinceIso` and stopping as soon as a page has none fresh (every
 * earlier page is older still) or `maxPages` is hit. Fault-tolerant like
 * `searchTopicRepos`: returns `{ stargazers: [], error }` on any non-2xx /
 * network / parse failure so the caller logs + continues to the next repo.
 *
 * Requires `GITHUB_TOKEN` for any real volume (5,000 req/hr core); without it
 * GitHub rate-limits hard at 60/hr.
 */
export async function recentStargazers(
  repo: string,
  opts: { sinceIso: string; maxPages?: number },
): Promise<{ stargazers: Stargazer[]; error?: string }> {
  const maxPages = Math.max(1, opts.maxPages ?? 20);
  // star+json gives us `starred_at`; otherwise it's a bare user list.
  const headers = { ...githubHeaders(), Accept: "application/vnd.github.star+json" };
  const base = `https://api.github.com/repos/${repo}/stargazers?per_page=100`;

  try {
    // Page 1 (oldest) is fetched first only to read the Link header; its rows
    // are reused if the backward walk reaches page 1.
    const firstRes = await fetch(`${base}&page=1`, { headers });
    if (!firstRes.ok) {
      logEvent("github.stargazers", { repo, ok: false, status: firstRes.status }, "warn");
      return { stargazers: [], error: `status ${firstRes.status}` };
    }
    const lastPage = parseLastPage(firstRes.headers.get("link"));
    const page1Rows = ((await firstRes.json()) as unknown[]) ?? [];

    const out: Stargazer[] = [];
    let pagesFetched = 1;
    for (let page = lastPage; page >= 1 && pagesFetched <= maxPages; page--) {
      let rows: unknown[];
      if (page === 1) {
        rows = page1Rows;
      } else {
        const res = await fetch(`${base}&page=${page}`, { headers });
        pagesFetched++;
        if (!res.ok) break;
        rows = ((await res.json()) as unknown[]) ?? [];
      }
      const parsed = rows
        .map(parseStarRow)
        .filter((s): s is Stargazer => s !== null && s.starredAt >= opts.sinceIso);
      out.push(...parsed);
      // Pages get older as `page` decreases; once a page yields zero fresh
      // stars, every earlier page is older too — stop.
      if (parsed.length === 0) break;
    }

    // Dedupe by login (defensive — a user stars a repo once).
    const seen = new Set<string>();
    const stargazers = out.filter((s) => {
      const key = s.login.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    logEvent("github.stargazers", {
      repo,
      ok: true,
      fresh: stargazers.length,
      last_page: lastPage,
      pages_fetched: pagesFetched,
    });
    return { stargazers };
  } catch (err) {
    const message = ((err as Error).message ?? "").slice(0, 120);
    logEvent("github.stargazers", { repo, ok: false, message_120: message }, "warn");
    return { stargazers: [], error: message };
  }
}
