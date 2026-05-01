import { logEvent } from "@oneshot-gtm/core";
import { githubHeaders } from "./_github-search.ts";

/**
 * Deterministic stack detection from a GitHub repo's manifest files. Replaces
 * the older webRead + LLM-extract path that was unreliable in two ways: (1)
 * webRead timed out on ~44% of GitHub README pages (JS-rendered), and (2)
 * READMEs are marketing copy that doesn't always match what the code
 * actually imports. Manifests are authoritative — if `openai` is in
 * `package.json`, the project uses OpenAI.
 *
 * Files we scan in priority order: package.json (npm), pyproject.toml +
 * requirements.txt (Python), .env.example (env-var leakage). Each fetch is
 * independent + best-effort; missing files just contribute nothing.
 *
 * The `vocab` argument is the founder-controlled vendor list. Each vocab
 * string is substring-matched (case-insensitive) against the union of all
 * extracted manifest tokens — `twilio` matches `twilio`, `twilio-node`,
 * `@twilio/voice-sdk`, AND `TWILIO_ACCOUNT_SID`. There is no hardcoded
 * vendor catalog; oneshot-gtm is a generic founder tool and competitive
 * vocabularies vary entirely by founder. The strategist proposes vocab
 * populations from the founder's product/ICP context (see
 * `packages/prompts/strategist-trigger.md`).
 *
 * Cost: ~3-4 GitHub API calls per candidate. With `GITHUB_TOKEN` set the
 * 5,000/hr quota is plenty for any practical run.
 */

export interface StackDetection {
  /** Founder-vocab vendors that matched at least one manifest token. Sorted. */
  detected: string[];
  /** Manifest filenames that were found (for diagnostics + event logging). */
  manifestsFound: string[];
}

/**
 * Scan a GitHub repo's manifests and return the founder-vocab vendors that
 * match at least one extracted package or env-var-key token.
 */
export async function detectRepoStack(args: {
  owner: string;
  repo: string;
  /** Founder's vendor list — substring-matched (case-insensitive) against
   *  manifest deps + env-var keys. Empty vocab → empty detection. */
  vocab: string[];
}): Promise<StackDetection> {
  const { owner, repo, vocab } = args;
  const targets = ["package.json", "pyproject.toml", "requirements.txt", ".env.example"];
  const fetched = await Promise.all(
    targets.map(async (path) => ({
      path,
      content: await fetchRepoFile(owner, repo, path),
    })),
  );

  const allNames = new Set<string>();
  const manifestsFound: string[] = [];
  for (const { path, content } of fetched) {
    if (!content) continue;
    manifestsFound.push(path);
    for (const name of namesFromManifest(path, content)) {
      allNames.add(name.toLowerCase());
    }
  }

  // Single transparent matching loop. Each vocab entry is a substring needle
  // searched across every extracted token. Casing doesn't matter (tokens
  // were lowercased on insertion). Substring is intentional: founder typing
  // `twilio` matches `twilio-node`, `@twilio/voice-sdk`, and `TWILIO_*` env
  // keys — three real signals from one vocab entry.
  const detected = new Set<string>();
  for (const v of vocab) {
    const needle = v.toLowerCase();
    if (needle.length === 0) continue;
    for (const n of allNames) {
      if (n.includes(needle)) {
        detected.add(v);
        break;
      }
    }
  }

  logEvent("github.repo.stack", {
    owner,
    repo,
    manifests_found: manifestsFound,
    detected_count: detected.size,
  });

  return {
    detected: [...detected].toSorted(),
    manifestsFound,
  };
}

/**
 * Fetch a file from a repo's default branch via the GitHub Contents API.
 * Returns null on any non-2xx (including 404 — file just doesn't exist),
 * network error, or unexpected content type. Same fault-tolerance pattern
 * as `fetchGitHubUser`.
 */
async function fetchRepoFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
  try {
    const headers = { ...githubHeaders(), Accept: "application/vnd.github.raw" };
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const text = await res.text();
    // Defensive cap. Manifests are usually < 50KB; anything larger is either
    // a spurious vendored file or a bug. We're only doing substring matches
    // so trimming is safe.
    return text.length > 200_000 ? text.slice(0, 200_000) : text;
  } catch {
    return null;
  }
}

/**
 * Extract dependency-like name strings from a manifest file's content.
 * Format-aware: each manifest has its own conventions.
 *
 * Exported for unit testing.
 */
export function namesFromManifest(path: string, content: string): string[] {
  if (path === "package.json") return parsePackageJson(content);
  if (path === "pyproject.toml") return parsePyProject(content);
  if (path === "requirements.txt") return parseRequirementsTxt(content);
  if (path === ".env.example") return parseEnvKeys(content);
  return [];
}

/** Pull `dependencies` + `devDependencies` keys out of a package.json. */
function parsePackageJson(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = obj[key];
    if (deps && typeof deps === "object") {
      out.push(...Object.keys(deps as Record<string, unknown>));
    }
  }
  return out;
}

/**
 * Pull dep names out of a pyproject.toml. We don't ship a TOML parser — a
 * regex over `name = "..."` patterns inside `[project.dependencies]` and
 * Poetry-style `[tool.poetry.dependencies]` sections covers the bulk of
 * real-world files. Fail-soft: missing matches just yield no names.
 */
function parsePyProject(content: string): string[] {
  const out: string[] = [];
  // Poetry: `package_name = "^1.2.3"` or `package_name = { version = ... }`
  const poetryRx = /^\s*([a-zA-Z0-9_\-.]+)\s*=\s*["{]/gm;
  let m: RegExpExecArray | null;
  while ((m = poetryRx.exec(content)) !== null) {
    const name = m[1];
    if (name && !RESERVED_PYPROJECT_KEYS.has(name.toLowerCase())) {
      out.push(name);
    }
  }
  // PEP 621: `dependencies = ["package_name>=1.0", ...]` — strings inside
  // an array of dependency specifiers.
  const pep621Rx = /["']([a-zA-Z0-9_\-.]+)\s*(?:[<>=!~][^"']*)?["']/g;
  while ((m = pep621Rx.exec(content)) !== null) {
    const name = m[1];
    if (name && name.length > 1) out.push(name);
  }
  return out;
}

/**
 * Reserved top-level keys in pyproject.toml that aren't dependencies. The
 * Poetry regex is loose enough to match these; this set filters them out.
 */
const RESERVED_PYPROJECT_KEYS = new Set([
  "name",
  "version",
  "description",
  "readme",
  "license",
  "authors",
  "maintainers",
  "homepage",
  "repository",
  "documentation",
  "keywords",
  "classifiers",
  "requires-python",
  "python",
  "dependencies",
  "optional-dependencies",
  "scripts",
  "entry-points",
  "urls",
  "include",
  "exclude",
  "build-backend",
  "build-system",
  "requires",
]);

/** First token of each non-comment line in requirements.txt. */
function parseRequirementsTxt(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("-")) continue;
    // Strip version specifier and extras: `package[extras]==1.0.0` → `package`
    const m = /^([a-zA-Z0-9_\-.]+)/.exec(line);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Pull env-var keys out of a `.env.example` (or `.env.sample`). Vendor SDKs
 * conventionally name their keys after themselves (`OPENAI_API_KEY`,
 * `TWILIO_ACCOUNT_SID`, etc), so the keys themselves are great signal even
 * when the values are placeholder.
 */
function parseEnvKeys(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.push(line.slice(0, eq).trim());
  }
  return out;
}
