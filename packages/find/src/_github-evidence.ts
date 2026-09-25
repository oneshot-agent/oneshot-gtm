import { fetchProfileReadmeText } from "./_github-readme.ts";
import { fetchTopRepos, type GitHubUserInfo, type TopRepo } from "./_github-user.ts";

/** Hard cap on the evidence block handed to a classifier. */
export const GITHUB_EVIDENCE_MAX_CHARS = 1200;
const README_EXCERPT_CHARS = 400;
const MAX_REPOS = 5;

type ProfileFields = Pick<
  GitHubUserInfo,
  "name" | "company" | "blogDomain" | "createdAt" | "publicRepos" | "followers"
>;

/**
 * The one-line profile summary shared by the angle evidence block and the
 * ICP evidence block, so both describe an account the same way.
 */
export function renderGitHubProfileLine(login: string, p: ProfileFields): string {
  return (
    `Profile: ${p.name ?? login}${p.company ? ` @ ${p.company}` : ""}` +
    `${p.blogDomain ? ` (${p.blogDomain})` : ""}` +
    `${p.createdAt ? ` — account created ${p.createdAt}` : ""}` +
    ` — ${p.publicRepos} public repos, ${p.followers} followers`
  );
}

/**
 * Reduce README markdown to readable prose: drop HTML, comments, images and
 * badges, keep link text, collapse whitespace. Purely presentational — the
 * email extractor keeps its own stricter parse.
 */
export function readmeExcerpt(markdown: string, max = README_EXCERPT_CHARS): string {
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/[*_`>|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function repoLine(r: TopRepo): string {
  const meta = [
    r.language,
    typeof r.stars === "number" && r.stars > 0 ? `★${r.stars}` : null,
    r.pushedAt ? `pushed ${r.pushedAt.slice(0, 7)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${r.name}${meta ? ` (${meta})` : ""}${r.description ? ` — ${r.description}` : ""}`;
}

/** True when the profile alone says nothing about what the person builds. */
function isThin(user: GitHubUserInfo, repos: TopRepo[] | null): boolean {
  return !user.bio && !user.company && !(repos ?? []).some((r) => r.description);
}

export interface GitHubEvidence {
  /** Plain-text block, ≤ GITHUB_EVIDENCE_MAX_CHARS, for a classifier prompt. */
  text: string;
  /** The candidate's own repos as fetched (null on a failed fetch). */
  repos: TopRepo[] | null;
  /** Whether the profile README was consulted (it costs up to two API calls). */
  readReadme: boolean;
}

/**
 * Everything GitHub already says about a person, as one bounded text block:
 * bio, company/site/location, account maturity, their own recent repos and —
 * only when all of that is empty — an excerpt of their profile README.
 *
 * API cost: the user record is passed in (already fetched); repos are one
 * call (cached per run); the README is 0–2 calls and only on thin profiles.
 */
export async function buildGitHubEvidence(
  user: GitHubUserInfo,
  opts: { repos?: TopRepo[] | null } = {},
): Promise<GitHubEvidence> {
  const repos = opts.repos !== undefined ? opts.repos : await fetchTopRepos(user.login);
  const lines: string[] = [renderGitHubProfileLine(user.login, user)];
  if (user.bio) lines.push(`Bio: ${user.bio}`);
  if (user.location) lines.push(`Location: ${user.location}`);
  if (repos && repos.length > 0) {
    lines.push("Own repos (most recently pushed):");
    for (const r of repos.slice(0, MAX_REPOS)) lines.push(repoLine(r));
  } else if (repos) {
    lines.push("Own repos: none public");
  }
  let readReadme = false;
  if (isThin(user, repos)) {
    readReadme = true;
    const md = await fetchProfileReadmeText({ login: user.login, accountType: user.accountType });
    const excerpt = md ? readmeExcerpt(md) : "";
    if (excerpt) lines.push(`Profile README: ${excerpt}`);
  }
  let text = lines.join("\n");
  if (text.length > GITHUB_EVIDENCE_MAX_CHARS) {
    text = `${text.slice(0, GITHUB_EVIDENCE_MAX_CHARS - 1)}…`;
  }
  return { text, repos, readReadme };
}
