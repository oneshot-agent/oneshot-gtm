/**
 * Generic GitHub-repo URL utilities used by the github-topics finder + the
 * shared `_repo-pipeline.ts`. Kept finder-agnostic — no combo / topic state.
 */

const NOISE_REPO_PATTERNS = [
  /^awesome[-_]/i,
  /[-_]awesome$/i,
  /^learn[-_]/i,
  /[-_]tutorial(s)?$/i,
  /^tutorial[-_]/i,
  /[-_]example(s)?$/i,
  /^example[-_]/i,
  /[-_]demo$/i,
  /^demo[-_]/i,
  /[-_]course$/i,
  /^course[-_]/i,
  /[-_]bootcamp$/i,
  /^cheatsheet/i,
  /[-_]boilerplate$/i,
  /^template[-_]/i,
];

/**
 * True when the repo name matches an "awesome list / tutorial / demo / course /
 * boilerplate" pattern. Catches the dominant non-buyer repos before the LLM
 * extract spends $0.02+ on them.
 */
export function looksLikeNoiseRepo(repoUrl: string): boolean {
  const name = repoUrl.split("/").pop() ?? "";
  return NOISE_REPO_PATTERNS.some((rx) => rx.test(name));
}

/** First-segment paths on github.com that are never repos (org pages, topic indexes, marketplace, …). */
const GITHUB_RESERVED_PATHS = new Set([
  "about",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "stars",
  "topics",
  "trending",
]);

/**
 * Reduce any GitHub URL down to a canonical `https://github.com/<owner>/<repo>`
 * form, or return null when the URL isn't a repo at all (gist host, reserved
 * first segment, missing repo segment, malformed). Strips `.git` suffix,
 * lowercases the host, drops query/hash and any path beyond owner+repo.
 */
export function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const segs = u.pathname.split("/").filter((s) => s.length > 0);
    if (segs.length < 2) return null;
    const [user, repo] = segs;
    if (!user || !repo) return null;
    if (GITHUB_RESERVED_PATHS.has(user.toLowerCase())) return null;
    const cleanRepo = repo.replace(/\.git$/i, "");
    return `https://github.com/${user}/${cleanRepo}`;
  } catch {
    return null;
  }
}
