import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { githubHeaders } from "./_github-search.ts";
import { fetchRepoFile } from "./_repo-stack.ts";

/**
 * Read-only access to the founder's source repo (`OneShotConfig.sourceRepo`),
 * for answering how-it-works questions from the code. Two readers, one
 * contract: the ref is resolved to a commit once, and every listing and
 * read happens at that commit, so a push mid-read cannot mix revisions.
 *
 * - GitHub (`url`): the REST API. A public repo needs no token; a private
 *   one needs GITHUB_TOKEN with read access.
 * - Local (`path`): `git` against a checkout. The working tree is never
 *   read, only committed content at the resolved ref.
 *
 * Never handed to the model, never even listed: secret-shaped files
 * (`.env*`, keys, credentials), lock files, vendored and build output,
 * binaries and anything large. `readFile` refuses those paths too, so a
 * file name the model invents cannot pull one in.
 */

export type SourceRepoConfig = NonNullable<OneShotConfig["sourceRepo"]>;

export interface SourceSnapshot {
  backend: "github" | "local";
  /** The ref read: the configured one, or the default branch it fell back to. */
  ref: string;
  /** The full commit sha every read is pinned to. */
  commit: string;
  /** Readable file paths at `commit`, filtered (see `isReadableSourcePath`). */
  listFiles(): Promise<string[]>;
  /** Content at `commit`; null when missing, filtered, binary or too large. */
  readFile(path: string): Promise<string | null>;
}

export type OpenSourceRepoResult =
  | { ok: true; snapshot: SourceSnapshot }
  | { ok: false; error: string };

/** Files larger than this are skipped: generated, data or vendored, rarely the answer. */
export const MAX_SOURCE_FILE_BYTES = 200_000;

const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "bower_components",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
  "pods",
]);

const LOCK_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "packages.lock.json",
]);

const BINARY_EXT = new Set(
  (
    "png jpg jpeg gif webp ico icns bmp tif tiff svg psd ai sketch fig pdf " +
    "zip gz tgz tar bz2 xz 7z rar jar war ear class so dylib dll exe bin o a lib wasm " +
    "woff woff2 ttf otf eot mp3 mp4 m4a mov avi mkv wav ogg webm flac " +
    "sqlite sqlite3 db pyc pyo parquet avro npy npz pkl pickle onnx pt pth h5 ckpt safetensors " +
    "map snap"
  ).split(" "),
);

/**
 * Secret-shaped: environment files, private keys and key stores,
 * credentials and secrets files, auth dotfiles, and anything under a
 * `secrets/` directory. Ordinary source that merely mentions a key in its
 * name (`idempotency-key.ts`, `keyboard.ts`) is read like any other file.
 */
export function isSecretShapedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.pop() ?? "";
  return (
    parts.some((p) => p === "secrets" || p === ".secrets") ||
    name.startsWith(".env") ||
    /^secrets?([._-]|$)/.test(name) ||
    /^credentials?([._-]|$)/.test(name) ||
    name.startsWith("id_rsa") ||
    name.startsWith("id_dsa") ||
    name.startsWith("id_ecdsa") ||
    name.startsWith("id_ed25519") ||
    /private[^/]*key/.test(name) ||
    /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(name) ||
    [".npmrc", ".netrc", ".pypirc", ".htpasswd", ".git-credentials", ".dockercfg"].includes(name)
  );
}

/**
 * Whether a path may be listed for, and read by, the answerer: not
 * secret-shaped, not a lock file, not under a vendored or build directory,
 * not a binary or minified asset, and not larger than
 * `MAX_SOURCE_FILE_BYTES` when its size is known.
 */
export function isReadableSourcePath(path: string, size?: number): boolean {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return false;
  if (size != null && size > MAX_SOURCE_FILE_BYTES) return false;
  if (isSecretShapedPath(path)) return false;
  const parts = path.split("/");
  const name = (parts.pop() ?? "").toLowerCase();
  if (parts.some((p) => SKIP_DIRS.has(p.toLowerCase()))) return false;
  if (LOCK_FILES.has(name) || name.endsWith(".lock")) return false;
  if (/\.min\.(js|css|mjs)$/.test(name)) return false;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return !BINARY_EXT.has(ext);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Text that is safe to hand over: no NUL bytes (binary), within the size cap. */
function usableText(text: string | null): string | null {
  if (text == null || text.includes("\u0000")) return null;
  return Buffer.byteLength(text, "utf8") > MAX_SOURCE_FILE_BYTES ? null : text;
}

/**
 * `owner/repo` (and a ref, when the URL names one) from a GitHub URL:
 * https://github.com/o/r(.git), …/tree/<ref>, git@github.com:o/r.git, or
 * the bare `o/r` shorthand. Null for anything else.
 */
export function parseGitHubRepoUrl(
  url: string,
): { owner: string; repo: string; ref?: string } | null {
  const raw = url.trim();
  const name = "[A-Za-z0-9_.-]+";
  const ssh = new RegExp(`^git@github\\.com:(${name})/(${name}?)(?:\\.git)?/?$`).exec(raw);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const short = /github\.com/i.test(raw) ? null : new RegExp(`^(${name})/(${name})$`).exec(raw);
  if (short) return { owner: short[1]!, repo: short[2]!.replace(/\.git$/, "") };
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
  const [owner, repoPart, kind, ...rest] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repoPart) return null;
  const repo = repoPart.replace(/\.git$/, "");
  if (!new RegExp(`^${name}$`).test(owner) || !new RegExp(`^${name}$`).test(repo)) return null;
  const ref = kind === "tree" && rest.length ? decodeURIComponent(rest.join("/")) : undefined;
  return { owner, repo, ...(ref ? { ref } : {}) };
}

/** A branch, tag or sha: no option-looking or revision-expression syntax reaches git. */
function validRef(ref: string): boolean {
  return !!ref && !ref.startsWith("-") && !/[\s~^:?*[\\]|\.\.|@\{/.test(ref);
}

/**
 * Resolve the configured repo to one commit and return a reader pinned to
 * it. Never throws: every failure is a plain sentence the founder can act
 * on (private repo without a token, missing folder, unknown ref).
 * `fetchRemote` (local only) first refreshes the remote a `origin/main`-style
 * ref points at, best effort, so a daily sweep reads what was pushed.
 */
export async function openSourceRepo(
  cfg: OneShotConfig["sourceRepo"] | null | undefined,
  opts: { fetchRemote?: boolean } = {},
): Promise<OpenSourceRepoResult> {
  const path = cfg?.path?.trim();
  const url = cfg?.url?.trim();
  const ref = cfg?.ref?.trim() || undefined;
  if (ref && !validRef(ref))
    return { ok: false, error: `'${ref}' is not a valid branch, tag or commit` };
  try {
    if (path) return await openLocal(path, ref, opts.fetchRemote === true);
    if (url) return await openGitHub(url, ref);
  } catch (err) {
    return { ok: false, error: (err as Error).message || "the source repo could not be read" };
  }
  return { ok: false, error: "no source repo is connected" };
}

// ---- GitHub -------------------------------------------------------------

const GITHUB_TIMEOUT_MS = 20_000;

async function githubJson(
  path: string,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

function githubError(status: number, what: string): string {
  const token = !!process.env["GITHUB_TOKEN"];
  if (status === 401) return "GitHub rejected GITHUB_TOKEN: check it in .env";
  if (status === 403 || status === 429)
    return token
      ? "GitHub's rate limit is reached; try again later"
      : "GitHub's rate limit is reached; a GITHUB_TOKEN in .env raises it";
  if (status === 404)
    return token
      ? `GitHub has no ${what} that GITHUB_TOKEN can read`
      : `GitHub has no public ${what}. If the repo is private, add a GITHUB_TOKEN that can read it to .env`;
  return `GitHub answered ${status} for ${what}`;
}

async function openGitHub(
  url: string,
  configuredRef: string | undefined,
): Promise<OpenSourceRepoResult> {
  const parsed = parseGitHubRepoUrl(url);
  if (!parsed)
    return {
      ok: false,
      error: `'${url}' is not a GitHub repo URL (https://github.com/owner/repo)`,
    };
  const { owner, repo } = parsed;
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const meta = await githubJson(base);
  if (!meta.ok) return { ok: false, error: githubError(meta.status, `repo ${owner}/${repo}`) };
  const defaultBranch = (meta.body as { default_branch?: unknown }).default_branch;
  const ref =
    configuredRef ?? parsed.ref ?? (typeof defaultBranch === "string" ? defaultBranch : "HEAD");
  const commitRes = await githubJson(`${base}/commits/${encodeURIComponent(ref)}`);
  if (!commitRes.ok)
    return {
      ok: false,
      error:
        commitRes.status === 404 || commitRes.status === 422
          ? `${owner}/${repo} has no branch, tag or commit '${ref}'`
          : githubError(commitRes.status, `ref '${ref}' of ${owner}/${repo}`),
    };
  const commit = (commitRes.body as { sha?: unknown }).sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    return { ok: false, error: `GitHub returned no commit for '${ref}'` };
  let listing: Promise<string[]> | null = null;
  const listFiles = (): Promise<string[]> =>
    (listing ??= (async () => {
      const tree = await githubJson(`${base}/git/trees/${commit}?recursive=1`);
      if (!tree.ok) throw new Error(githubError(tree.status, `the file list of ${owner}/${repo}`));
      const entries = (tree.body as { tree?: unknown }).tree;
      if (!Array.isArray(entries)) return [];
      return entries
        .filter(
          (e): e is { path: string; type: string; size?: number } =>
            !!e && typeof e.path === "string" && e.type === "blob",
        )
        .filter((e) =>
          isReadableSourcePath(e.path, typeof e.size === "number" ? e.size : undefined),
        )
        .map((e) => e.path)
        .toSorted();
    })());
  return {
    ok: true,
    snapshot: {
      backend: "github",
      ref,
      commit,
      listFiles,
      async readFile(p) {
        if (!isReadableSourcePath(p)) return null;
        return usableText(await fetchRepoFile(owner, repo, p, commit));
      },
    },
  };
}

// ---- local git checkout -------------------------------------------------

const GIT_TIMEOUT_MS = 30_000;

/** Run git without blocking the event loop (the server shares it with every request). */
async function git(
  dir: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, out, err: err.trim() };
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

async function openLocal(
  rawPath: string,
  configuredRef: string | undefined,
  fetchRemote: boolean,
): Promise<OpenSourceRepoResult> {
  const expanded = expandHome(rawPath);
  if (!isAbsolute(expanded))
    return { ok: false, error: `use the full path of the checkout, not '${rawPath}'` };
  const dir = resolve(expanded);
  if (!existsSync(dir)) return { ok: false, error: `no folder at ${dir}` };
  if (!(await git(dir, ["rev-parse", "--git-dir"])).ok)
    return { ok: false, error: `${dir} is not a git checkout` };
  let ref = configuredRef;
  if (!ref) {
    const head = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    ref = head.ok && head.out.trim() ? head.out.trim() : "HEAD";
  }
  if (fetchRemote) {
    const remote = ref.split("/")[0]!;
    const remotes = (await git(dir, ["remote"])).out.split("\n").map((r) => r.trim());
    if (ref.includes("/") && remotes.includes(remote))
      await git(dir, ["fetch", "--quiet", "--no-tags", remote], 60_000);
  }
  const resolved = await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const commit = resolved.out.trim();
  if (!resolved.ok || !/^[0-9a-f]{40,64}$/.test(commit))
    return { ok: false, error: `${dir} has no branch, tag or commit '${ref}'` };
  let listing: string[] | null = null;
  return {
    ok: true,
    snapshot: {
      backend: "local",
      ref,
      commit,
      async listFiles() {
        if (listing) return listing;
        const tree = await git(dir, ["ls-tree", "-r", "-l", "-z", commit]);
        if (!tree.ok)
          throw new Error(`could not list ${dir} at ${commit.slice(0, 7)}: ${tree.err}`);
        listing = tree.out
          .split("\u0000")
          .map((entry) => {
            // "<mode> <type> <object> <size>\t<path>"
            const tab = entry.indexOf("\t");
            if (tab < 0) return null;
            const [mode, type, , size] = entry.slice(0, tab).trim().split(/\s+/);
            if (type !== "blob" || mode === "120000") return null;
            const path = entry.slice(tab + 1);
            return isReadableSourcePath(path, Number(size)) ? path : null;
          })
          .filter((p): p is string => p != null)
          .toSorted();
        return listing;
      },
      async readFile(p) {
        if (!isReadableSourcePath(p)) return null;
        const show = await git(dir, ["cat-file", "blob", `${commit}:${p}`]);
        return show.ok ? usableText(show.out) : null;
      },
    },
  };
}
