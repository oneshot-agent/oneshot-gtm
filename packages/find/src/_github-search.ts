import { logEvent } from "@oneshot-gtm/core";

export interface GitHubSearchRepo {
  /** html_url, normalized to canonical github.com/<owner>/<repo>. */
  url: string;
  /** owner/repo. */
  fullName: string;
  description: string | null;
  stars: number;
  /** Self-tagged GitHub topic slugs from the repo's metadata. */
  topics: string[];
  language: string | null;
  pushedAt: string;
}

/**
 * Search the GitHub Search API for repos tagged with a topic.
 *
 * Uses `GITHUB_TOKEN` from env if set (30 req/min, exempt from secondary
 * abuse detection); falls back to unauthenticated (10 req/min, AND vulnerable
 * to GitHub silently returning empty results when soft-blocked for "too many"
 * unauth queries from the same IP — no 429, no error, just zero hits).
 *
 * Returns [] on:
 *   - 422 (invalid query — usually a malformed topic slug)
 *   - 403 (GitHub's actual unauth rate-limit signal)
 *   - 429 (explicit rate-limit)
 *   - any other non-2xx
 *   - network error
 *   - malformed JSON
 *
 * Same fault-tolerance pattern as `fetchGitHubUser`.
 */
export async function searchTopicRepos(args: {
  topic: string;
  minStars: number;
  /** ISO date string (YYYY-MM-DD) for the `pushed:>=` filter. */
  pushedSinceIso: string;
  /** Page size. <=100. */
  perPage: number;
}): Promise<GitHubSearchRepo[]> {
  const q = `topic:${args.topic} stars:>=${args.minStars} pushed:>=${args.pushedSinceIso}`;
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
    `&sort=updated&order=desc&per_page=${Math.max(1, Math.min(100, args.perPage))}`;
  try {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
      logEvent("github.topic.search", {
        topic: args.topic,
        ok: false,
        status: res.status,
      });
      return [];
    }
    const json = (await res.json()) as Record<string, unknown>;
    const items = Array.isArray(json["items"])
      ? (json["items"] as Array<Record<string, unknown>>)
      : [];
    const repos = items.map(parseSearchItem).filter((r): r is GitHubSearchRepo => r !== null);
    // Detect GitHub's silent soft-block: 200 OK + empty items + total_count
    // reported as 0 even on slugs that should match (e.g. `langchain`). When
    // the unauth IP gets flagged for abuse, this is the failure mode — no
    // 429, just 0 hits forever for an hour or two. Surface a hint so the
    // caller can stop hammering and the operator can act (set GITHUB_TOKEN).
    const totalCount =
      typeof json["total_count"] === "number" ? (json["total_count"] as number) : null;
    const authed = Boolean(process.env["GITHUB_TOKEN"]);
    const ratelimitHint = !authed && repos.length === 0 && totalCount === 0;
    logEvent("github.topic.search", {
      topic: args.topic,
      ok: true,
      count: repos.length,
      total_count: totalCount,
      authed,
      ...(ratelimitHint ? { hint: "0 hits + unauth — likely soft-blocked; set GITHUB_TOKEN" } : {}),
    });
    return repos;
  } catch (err) {
    logEvent(
      "github.topic.search",
      {
        topic: args.topic,
        ok: false,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return [];
  }
}

/**
 * Build request headers for the GitHub REST API. Adds `Authorization: Bearer`
 * when `GITHUB_TOKEN` is set, lifting our quota from 10 req/min unauth →
 * 30 req/min for search (5,000/hour for everything else) AND making us
 * exempt from secondary abuse detection on the search endpoint.
 *
 * Exported so `_github-user.ts` can use the same auth shape.
 */
export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env["GITHUB_TOKEN"];
  if (token && token.length > 0) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/** Parse one search-API `items[]` entry. Returns null on missing required fields. */
export function parseSearchItem(raw: Record<string, unknown>): GitHubSearchRepo | null {
  const htmlUrl = typeof raw["html_url"] === "string" ? (raw["html_url"] as string) : null;
  const fullName = typeof raw["full_name"] === "string" ? (raw["full_name"] as string) : null;
  if (!htmlUrl || !fullName) return null;
  return {
    url: htmlUrl,
    fullName,
    description: typeof raw["description"] === "string" ? (raw["description"] as string) : null,
    stars: typeof raw["stargazers_count"] === "number" ? (raw["stargazers_count"] as number) : 0,
    topics: Array.isArray(raw["topics"])
      ? (raw["topics"] as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    language: typeof raw["language"] === "string" ? (raw["language"] as string) : null,
    pushedAt: typeof raw["pushed_at"] === "string" ? (raw["pushed_at"] as string) : "",
  };
}

/**
 * Format a date as YYYY-MM-DD for the GitHub `pushed:>=` query operator.
 * Pulled out so callers can inject `now` for testing.
 */
export function isoDateNDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
