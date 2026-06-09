import { logEvent } from "@oneshot-gtm/core";
import { githubHeaders } from "./_github-search.ts";

export interface GitHubUserInfo {
  login: string;
  /** Human-friendly display name (e.g. "Ada Lovelace") when set. Falls back
   *  to null — many users leave this blank. */
  name: string | null;
  email: string | null;
  /** A bare hostname extracted from the user's blog URL when present. */
  blogDomain: string | null;
  /** company string from the user's profile (e.g. "@acme" or "Acme Inc"). */
  company: string | null;
}

/**
 * Per-process cache of GitHub user lookups. Keyed by login (lowercased to
 * dedupe `Foo` vs `foo` from different combos that surface the same author).
 * `null` is a real cached value — it means we've already tried and the API
 * returned 404 / 429 / network error, so don't retry within the run.
 */
const cache = new Map<string, GitHubUserInfo | null>();

/** Test-only: drop the in-memory cache between cases. */
export function _resetGitHubUserCache(): void {
  cache.clear();
}

/**
 * Fetch a GitHub user's public profile via the unauthenticated REST API.
 * Returns null on 404, 403 (GitHub's actual unauth rate-limit signal), 429,
 * any other non-2xx, network error, or malformed response — caller should
 * fall through to the next enrichment strategy rather than treat this as
 * fatal.
 *
 * Unauthenticated quota is 60 req/hour per IP, which is fine for the ~50
 * candidates a single github-topics run inspects. Same-author dedupe via
 * the cache keeps actual fetches down further (a popular author appearing
 * in multiple combos hits the API once).
 */
export async function fetchGitHubUser(login: string): Promise<GitHubUserInfo | null> {
  const key = login.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: githubHeaders(),
    });
    if (res.status === 404) {
      cache.set(key, null);
      logEvent("github.user.fetch", { login, ok: false, status: 404 });
      return null;
    }
    if (res.status === 429 || res.status === 403) {
      // 403 with rate-limit headers is GitHub's actual rate-limit signal for
      // unauthenticated callers. Treat both as "back off, try later."
      cache.set(key, null);
      logEvent("github.user.fetch", { login, ok: false, status: res.status, rate_limited: true });
      return null;
    }
    if (!res.ok) {
      cache.set(key, null);
      logEvent("github.user.fetch", { login, ok: false, status: res.status });
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    const info: GitHubUserInfo = {
      login: typeof json["login"] === "string" ? (json["login"] as string) : login,
      name:
        typeof json["name"] === "string" && json["name"] !== "" ? (json["name"] as string) : null,
      email:
        typeof json["email"] === "string" && json["email"] !== ""
          ? (json["email"] as string)
          : null,
      blogDomain: extractBlogDomain(json["blog"]),
      company:
        typeof json["company"] === "string" && json["company"] !== ""
          ? (json["company"] as string)
          : null,
    };
    cache.set(key, info);
    logEvent("github.user.fetch", {
      login,
      ok: true,
      has_email: info.email !== null,
      has_blog: info.blogDomain !== null,
    });
    return info;
  } catch (err) {
    cache.set(key, null);
    logEvent(
      "github.user.fetch",
      {
        login,
        ok: false,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

/**
 * One of the candidate's own public repos, stripped to the fields the email
 * prompt actually weaves in. Forks are excluded CLIENT-SIDE in fetchTopRepos's
 * filter chain (GitHub's `type=owner` query param filters by ownership
 * relation — owner vs collaborator-via-member — NOT by fork status; a fork the
 * user owns is still returned). Star count + dates are intentionally dropped
 * to keep token budget tight — the LLM picks ONE repo (if any) by topical fit,
 * not by metrics.
 */
export interface TopRepo {
  name: string;
  description: string | null;
  language: string | null;
}

/**
 * Per-process cache of `/users/{login}/repos` lookups. Same shape + semantics
 * as the user-profile cache above: `null` is a real value meaning "we tried
 * and got 404 / 429 / network error, don't retry within the run."
 */
const reposCache = new Map<string, TopRepo[] | null>();

/** Test-only: drop the in-memory repos cache between cases. */
export function _resetTopReposCache(): void {
  reposCache.clear();
}

/**
 * Fetch the candidate's top 10 OWN public repos, sorted by most-recent push
 * — i.e. "what they actively ship." No star filter (a one-star repo can still
 * be the most-telling signal of what they care about right now). Forks are
 * dropped client-side in the filter chain below — they're a weak signal of
 * authorship AND with `sort=pushed` a fork tracking a busy upstream
 * (kubernetes, next.js) would float to the top and get framed to the LLM as
 * shipping evidence.
 *
 * Note: GitHub's `type=owner` URL param filters by OWNERSHIP relation (owner
 * vs collaborator-via-member), NOT by fork status. The endpoint has no
 * `fork=false` param; client-side filtering on the response is the only way.
 *
 * Returns null on any non-2xx / network error / parse failure — caller treats
 * an absent enrichment as "skip the repos block in the prompt," never fatal.
 * Empty array (user has no public repos / all private) stays `[]`, distinct
 * from null, so callers can tell "no data" from "no repos."
 */
export async function fetchTopRepos(login: string): Promise<TopRepo[] | null> {
  const key = login.toLowerCase();
  if (reposCache.has(key)) return reposCache.get(key) ?? null;
  try {
    const url = `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=10&sort=pushed&type=owner`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (res.status === 404) {
      reposCache.set(key, null);
      logEvent("github.repos.fetch", { login, ok: false, status: 404 });
      return null;
    }
    if (res.status === 429 || res.status === 403) {
      reposCache.set(key, null);
      logEvent("github.repos.fetch", {
        login,
        ok: false,
        status: res.status,
        rate_limited: true,
      });
      return null;
    }
    if (!res.ok) {
      reposCache.set(key, null);
      logEvent("github.repos.fetch", { login, ok: false, status: res.status });
      return null;
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(json)) {
      reposCache.set(key, null);
      logEvent("github.repos.fetch", { login, ok: false, status: res.status, malformed: true });
      return null;
    }
    // Drop:
    //   - forks (type=owner doesn't exclude them; daily-syncing forks of
    //     popular OSS would float to the top via sort=pushed and read as
    //     shipping evidence to the LLM)
    //   - archived repos (sort=pushed can float a recently-archived repo)
    //   - entries without a usable name (defensive against API drift)
    // Cap description length so a few wordy READMEs can't blow up the prompt
    // token budget — 160 chars is roughly one full sentence, enough for the
    // LLM to judge topical fit.
    const repos: TopRepo[] = json
      .filter(
        (r) =>
          r["archived"] !== true &&
          r["fork"] !== true &&
          typeof r["name"] === "string" &&
          r["name"] !== "",
      )
      .map((r) => {
        const rawDesc =
          typeof r["description"] === "string" && r["description"] !== ""
            ? (r["description"] as string)
            : null;
        return {
          name: r["name"] as string,
          description: rawDesc && rawDesc.length > 160 ? `${rawDesc.slice(0, 159)}…` : rawDesc,
          language: typeof r["language"] === "string" ? (r["language"] as string) : null,
        };
      });
    reposCache.set(key, repos);
    logEvent("github.repos.fetch", { login, ok: true, count: repos.length });
    return repos;
  } catch (err) {
    reposCache.set(key, null);
    logEvent(
      "github.repos.fetch",
      {
        login,
        ok: false,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

/**
 * Normalize a profile `blog` field to a bare hostname.
 *
 * GitHub stores whatever the user typed, so this needs to handle:
 * `https://acme.dev`, `acme.dev`, `www.acme.dev`, `https://acme.dev/about`,
 * `acme.dev?utm=x`, and (commonly) the empty string. Returns null on anything
 * that doesn't look like a usable hostname.
 */
export function extractBlogDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host.length === 0 || !host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Pull the `<owner>` segment out of a `https://github.com/<owner>/<repo>` URL
 * so callers don't have to re-implement URL parsing. Returns null if the URL
 * isn't a normalized GitHub repo URL.
 */
export function ownerFromRepoUrl(repoUrl: string): string | null {
  try {
    const u = new URL(repoUrl);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 1) return null;
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull the `<repo>` segment out of a `https://github.com/<owner>/<repo>` URL.
 * Returns null when the URL doesn't have a repo segment (org page, gist, etc).
 */
export function repoNameFromRepoUrl(repoUrl: string): string | null {
  try {
    const u = new URL(repoUrl);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return parts[1] ?? null;
  } catch {
    return null;
  }
}
