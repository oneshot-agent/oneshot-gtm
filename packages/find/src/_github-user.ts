import { logEvent } from "@oneshot-gtm/core";
import { githubHeaders } from "./_github-search.ts";

export interface GitHubUserInfo {
  login: string;
  name: string | null;
  email: string | null;
  /** Bare hostname extracted from the user's blog URL. */
  blogDomain: string | null;
  company: string | null;
  /**
   * Account-maturity signal (issue #355 refinement): a `created_at` within
   * the last few months plus a low `publicRepos`/`followers` count is what
   * separates a student/hobby account from an established one — the same
   * repo list reads very differently behind each. `null` on a field GitHub
   * didn't return (never observed in practice for `created_at`, but kept
   * optional-safe like every other field here).
   */
  createdAt: string | null;
  publicRepos: number;
  followers: number;
}

/** Lowercase-keyed cache; `null` = "tried, got 404/429/network error". */
const cache = new Map<string, GitHubUserInfo | null>();

/** Test-only: drop the in-memory cache between cases. */
export function _resetGitHubUserCache(): void {
  cache.clear();
}

/**
 * Fetch a GitHub user's public profile via the unauth REST API. 403 is
 * GitHub's actual unauth rate-limit signal (not 429); treat both as
 * back-off. Null on any failure — caller falls through to the next
 * enrichment strategy.
 *
 * Unauth quota is 60 req/hour per IP. The cache keeps a popular author
 * surfaced by multiple combos at one API hit.
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
      createdAt: typeof json["created_at"] === "string" ? (json["created_at"] as string) : null,
      publicRepos: typeof json["public_repos"] === "number" ? (json["public_repos"] as number) : 0,
      followers: typeof json["followers"] === "number" ? (json["followers"] as number) : 0,
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
 * One of the candidate's own public repos. Star count + dates intentionally
 * dropped to keep token budget tight — the LLM picks ONE by topical fit, not
 * metrics.
 */
export interface TopRepo {
  name: string;
  description: string | null;
  language: string | null;
}

/** `null` = "we tried and got 404/429/network error, don't retry within the run." */
const reposCache = new Map<string, TopRepo[] | null>();

/** Test-only: drop the in-memory repos cache between cases. */
export function _resetTopReposCache(): void {
  reposCache.clear();
}

/**
 * Fetch the candidate's top 10 OWN public repos, sorted by most-recent push.
 *
 * `null` return: any non-2xx / network error / parse failure — caller skips
 * the repos block in the prompt. Empty `[]` is distinct from `null` and means
 * "we asked, user has no public repos".
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
    // Drop forks (GitHub's `type=owner` filters by ownership relation, NOT
    // fork status — a daily-syncing fork of kubernetes/next.js would float to
    // the top via sort=pushed and read as shipping evidence to the LLM).
    // Drop archived + missing-name entries. Cap description at 160 chars.
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
 * One of the candidate's GitHub organizations — company/collective signal
 * that a bare repo list can't distinguish (a student-led "lab" org reads the
 * same as a funded company until you check WHO'S behind it). Company/blog
 * dropped: `fetchGitHubOrgProfile` below fetches those for the org itself, on
 * demand, rather than the user-orgs endpoint's summary line.
 */
export interface GitHubOrgRef {
  login: string;
  description: string | null;
}

/** `null` = "we tried and got 404/429/network error, don't retry within the run." */
const orgsCache = new Map<string, GitHubOrgRef[] | null>();

/** Test-only: drop the in-memory orgs cache between cases. */
export function _resetGitHubOrgsCache(): void {
  orgsCache.clear();
}

/**
 * Fetch the orgs a GitHub user publicly belongs to. Same null/[]/error-shape
 * contract as `fetchTopRepos`: `null` = couldn't ask, `[]` = asked, no orgs.
 */
export async function fetchGitHubOrgs(login: string): Promise<GitHubOrgRef[] | null> {
  const key = login.toLowerCase();
  if (orgsCache.has(key)) return orgsCache.get(key) ?? null;
  try {
    const url = `https://api.github.com/users/${encodeURIComponent(login)}/orgs`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (res.status === 404) {
      orgsCache.set(key, null);
      logEvent("github.orgs.fetch", { login, ok: false, status: 404 });
      return null;
    }
    if (res.status === 429 || res.status === 403) {
      orgsCache.set(key, null);
      logEvent("github.orgs.fetch", { login, ok: false, status: res.status, rate_limited: true });
      return null;
    }
    if (!res.ok) {
      orgsCache.set(key, null);
      logEvent("github.orgs.fetch", { login, ok: false, status: res.status });
      return null;
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(json)) {
      orgsCache.set(key, null);
      logEvent("github.orgs.fetch", { login, ok: false, status: res.status, malformed: true });
      return null;
    }
    const orgs: GitHubOrgRef[] = json
      .filter(
        (o): o is Record<string, unknown> & { login: string } => typeof o["login"] === "string",
      )
      .map((o) => ({
        login: o.login,
        description:
          typeof o["description"] === "string" && o["description"] !== ""
            ? (o["description"] as string)
            : null,
      }));
    orgsCache.set(key, orgs);
    logEvent("github.orgs.fetch", { login, ok: true, count: orgs.length });
    return orgs;
  } catch (err) {
    orgsCache.set(key, null);
    logEvent(
      "github.orgs.fetch",
      { login, ok: false, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/**
 * Fetch an org's own profile — bio + public repo count. This is what
 * distinguishes "AxiomNode" the one-month-old student lab from a funded
 * company of the same shape: `fetchGitHubOrgs` only returns the name.
 * `null` on any failure; the caller treats a missing org profile as "unknown",
 * never as a negative signal.
 */
export interface GitHubOrgProfile {
  login: string;
  name: string | null;
  description: string | null;
  publicRepos: number;
  createdAt: string | null;
}

/** `null` = "we tried and got 404/429/network error, don't retry within the run." */
const orgProfileCache = new Map<string, GitHubOrgProfile | null>();

/** Test-only: drop the in-memory org-profile cache between cases. */
export function _resetGitHubOrgProfileCache(): void {
  orgProfileCache.clear();
}

export async function fetchGitHubOrgProfile(login: string): Promise<GitHubOrgProfile | null> {
  const key = login.toLowerCase();
  if (orgProfileCache.has(key)) return orgProfileCache.get(key) ?? null;
  try {
    const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(login)}`, {
      headers: githubHeaders(),
    });
    if (!res.ok) {
      orgProfileCache.set(key, null);
      logEvent("github.org_profile.fetch", { login, ok: false, status: res.status });
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    const profile: GitHubOrgProfile = {
      login: typeof json["login"] === "string" ? (json["login"] as string) : login,
      name:
        typeof json["name"] === "string" && json["name"] !== "" ? (json["name"] as string) : null,
      description:
        typeof json["description"] === "string" && json["description"] !== ""
          ? (json["description"] as string)
          : null,
      publicRepos: typeof json["public_repos"] === "number" ? (json["public_repos"] as number) : 0,
      createdAt: typeof json["created_at"] === "string" ? (json["created_at"] as string) : null,
    };
    orgProfileCache.set(key, profile);
    logEvent("github.org_profile.fetch", { login, ok: true });
    return profile;
  } catch (err) {
    orgProfileCache.set(key, null);
    logEvent(
      "github.org_profile.fetch",
      { login, ok: false, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/** A bare login reference from GitHub's paginated following/followers lists. */
export interface GitHubFollowRef {
  login: string;
}

/** Following + followers, each capped — the network signal is "who's in their
 *  orbit", not a full graph; the caller looks for a handful of names it
 *  already recognizes (a colleague, a known builder), not a directory. */
export interface GitHubFollowNetwork {
  following: GitHubFollowRef[];
  followers: GitHubFollowRef[];
}

const FOLLOW_PAGE_SIZE = 30;

/** `null` = "we tried and got 404/429/network error, don't retry within the run." */
const followCache = new Map<string, GitHubFollowNetwork | null>();

/** Test-only: drop the in-memory follow-network cache between cases. */
export function _resetGitHubFollowCache(): void {
  followCache.clear();
}

async function fetchLoginList(url: string): Promise<GitHubFollowRef[] | null> {
  try {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return null;
    return json
      .filter(
        (u): u is Record<string, unknown> & { login: string } =>
          typeof (u as Record<string, unknown>)["login"] === "string",
      )
      .map((u) => ({ login: u.login }));
  } catch {
    // A thrown fetch (network error, DNS failure, etc.) must degrade this one
    // side to null exactly like a non-ok status does, so the caller's
    // Promise.all still lets a succeeding sibling side through instead of
    // rejecting the whole lookup (finding PRRT_kwDOSKzrBs6gUX7W).
    return null;
  }
}

/**
 * Fetch a capped page of who this candidate follows and who follows them.
 * Both lists fetched in parallel — this is one logical "network" lookup, not
 * two independent calls a caller should have to sequence. `null` on total
 * failure (both lists unreachable); a partial failure degrades that one side
 * to an empty list rather than discarding the side that did succeed.
 */
export async function fetchFollowNetwork(login: string): Promise<GitHubFollowNetwork | null> {
  const key = login.toLowerCase();
  if (followCache.has(key)) return followCache.get(key) ?? null;
  const encoded = encodeURIComponent(login);
  try {
    const [following, followers] = await Promise.all([
      fetchLoginList(
        `https://api.github.com/users/${encoded}/following?per_page=${FOLLOW_PAGE_SIZE}`,
      ),
      fetchLoginList(
        `https://api.github.com/users/${encoded}/followers?per_page=${FOLLOW_PAGE_SIZE}`,
      ),
    ]);
    if (following === null && followers === null) {
      followCache.set(key, null);
      logEvent("github.follow_network.fetch", { login, ok: false });
      return null;
    }
    const network: GitHubFollowNetwork = {
      following: following ?? [],
      followers: followers ?? [],
    };
    followCache.set(key, network);
    logEvent("github.follow_network.fetch", {
      login,
      ok: true,
      following_count: network.following.length,
      followers_count: network.followers.length,
    });
    return network;
  } catch (err) {
    followCache.set(key, null);
    logEvent(
      "github.follow_network.fetch",
      { login, ok: false, message_120: ((err as Error).message ?? "").slice(0, 120) },
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
