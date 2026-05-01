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
      name: typeof json["name"] === "string" && json["name"] !== "" ? (json["name"] as string) : null,
      email: typeof json["email"] === "string" && json["email"] !== "" ? (json["email"] as string) : null,
      blogDomain: extractBlogDomain(json["blog"]),
      company: typeof json["company"] === "string" && json["company"] !== "" ? (json["company"] as string) : null,
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
