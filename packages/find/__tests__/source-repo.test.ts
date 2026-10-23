import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isReadableSourcePath,
  openSourceRepo,
  parseGitHubRepoUrl,
  type SourceSnapshot,
} from "../src/source-repo.ts";

// The two source readers behind answers from your code: a local checkout
// read with git at one commit, and GitHub's REST API. Secret-shaped, vendored,
// lock and binary files are never listed and never read.

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

async function open(cfg: { path?: string; url?: string; ref?: string }): Promise<SourceSnapshot> {
  const out = await openSourceRepo(cfg);
  if (!out.ok) throw new Error(out.error);
  return out.snapshot;
}

describe("isReadableSourcePath", () => {
  it.each([
    ".env",
    ".env.production",
    "config/.env.local",
    "certs/server.pem",
    "deploy/private-key.json",
    "deploy/privatekey.txt",
    "certs/server.key",
    "certs/store.p12",
    "certs/store.pfx",
    "home/.ssh/id_rsa",
    "home/.ssh/id_ed25519.pub",
    "secrets.yaml",
    "secret.json",
    "credentials.json",
    "config/secrets/prod.yaml",
    "node_modules/x/index.js",
    "dist/app.js",
    "bun.lock",
    "package-lock.json",
    "Cargo.lock",
    "logo.png",
    "public/app.min.js",
    "../outside.ts",
  ])("skips %s", (path) => {
    expect(isReadableSourcePath(path)).toBe(false);
  });

  it.each([
    "src/approve.ts",
    "README.md",
    "lib/queue/worker.py",
    "package.json",
    // Source that only mentions a key or a secret in its name is ordinary source.
    "src/idempotency-key.ts",
    "src/keyboard.ts",
    "src/api-keys/route.ts",
  ])("reads %s", (path) => {
    expect(isReadableSourcePath(path)).toBe(true);
  });

  it("skips a file over the size cap", () => {
    expect(isReadableSourcePath("src/big.ts", 500_000)).toBe(false);
  });
});

describe("parseGitHubRepoUrl", () => {
  it.each([
    ["https://github.com/acme/widgets", { owner: "acme", repo: "widgets" }],
    ["https://github.com/acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["github.com/acme/widgets/", { owner: "acme", repo: "widgets" }],
    ["git@github.com:acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["acme/widgets", { owner: "acme", repo: "widgets" }],
    [
      "https://github.com/acme/widgets/tree/release/2.0",
      { owner: "acme", repo: "widgets", ref: "release/2.0" },
    ],
  ])("%s", (url, want) => {
    expect(parseGitHubRepoUrl(url)).toEqual(want);
  });

  it("rejects other hosts", () => {
    expect(parseGitHubRepoUrl("https://gitlab.com/acme/widgets")).toBeNull();
  });
});

describe("local checkout", () => {
  let dir: string;
  let first: string;
  let second: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oneshot-source-repo-"));
    git(dir, "init", "-q", "-b", "main");
    write(dir, "src/approve.ts", "export const first = 1;\n");
    write(dir, ".env", "API_TOKEN=do-not-read\n");
    write(dir, "config/secrets.json", '{"token":"x"}');
    write(dir, "node_modules/dep/index.js", "module.exports = 1;\n");
    write(dir, "README.md", "# Widgets\n");
    git(dir, "add", "-A", "-f");
    git(dir, "commit", "-q", "-m", "one");
    first = git(dir, "rev-parse", "HEAD");
    write(dir, "src/approve.ts", "export const second = 2;\n");
    git(dir, "commit", "-q", "-am", "two");
    second = git(dir, "rev-parse", "HEAD");
    // The working tree is never read: only committed content at the ref.
    write(dir, "src/approve.ts", "uncommitted\n");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to HEAD and reads committed content at that commit", async () => {
    const snap = await open({ path: dir });
    expect(snap).toMatchObject({ backend: "local", ref: "HEAD", commit: second });
    expect(await snap.readFile("src/approve.ts")).toBe("export const second = 2;\n");
  });

  it("reads an older commit when the ref names it", async () => {
    const snap = await open({ path: dir, ref: first });
    expect(snap.commit).toBe(first);
    expect(await snap.readFile("src/approve.ts")).toBe("export const first = 1;\n");
  });

  it("never lists or reads secret-shaped or vendored files", async () => {
    const snap = await open({ path: dir });
    expect(await snap.listFiles()).toEqual(["README.md", "src/approve.ts"]);
    expect(await snap.readFile(".env")).toBeNull();
    expect(await snap.readFile("config/secrets.json")).toBeNull();
    expect(await snap.readFile("node_modules/dep/index.js")).toBeNull();
  });

  it("explains a missing folder, a non-repo and an unknown ref", async () => {
    expect(await openSourceRepo({ path: join(dir, "nope") })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no folder"),
    });
    const plain = mkdtempSync(join(tmpdir(), "oneshot-not-a-repo-"));
    try {
      expect(await openSourceRepo({ path: plain })).toMatchObject({
        ok: false,
        error: expect.stringContaining("not a git checkout"),
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(await openSourceRepo({ path: dir, ref: "no-such-branch" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no-such-branch"),
    });
    expect(await openSourceRepo({ path: dir, ref: "--upload-pack=x" })).toMatchObject({
      ok: false,
    });
    expect(await openSourceRepo({ path: "relative/path" })).toMatchObject({ ok: false });
  });
});

describe("GitHub", () => {
  const realFetch = globalThis.fetch;
  const SHA = "c".repeat(40);
  let calls: string[];
  let token: string | undefined;

  beforeEach(() => {
    calls = [];
    token = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (token === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = token;
  });

  function mockGitHub(routes: Record<string, { status?: number; body: unknown }>): void {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input).replace("https://api.github.com", "");
      calls.push(url);
      const hit = routes[url];
      if (!hit) return new Response("not found", { status: 404 });
      const body = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
      return new Response(body, { status: hit.status ?? 200 });
    }) as unknown as typeof fetch;
  }

  it("resolves the default branch to a sha and reads every file at it", async () => {
    mockGitHub({
      "/repos/acme/widgets": { body: { default_branch: "main" } },
      "/repos/acme/widgets/commits/main": { body: { sha: SHA } },
      [`/repos/acme/widgets/git/trees/${SHA}?recursive=1`]: {
        body: {
          tree: [
            { path: "src/approve.ts", type: "blob", size: 120 },
            { path: ".env", type: "blob", size: 20 },
            { path: "src", type: "tree" },
            { path: "assets/huge.json", type: "blob", size: 9_000_000 },
          ],
        },
      },
      [`/repos/acme/widgets/contents/src/approve.ts?ref=${SHA}`]: { body: "export const x = 1;\n" },
      [`/repos/acme/widgets/contents/.env?ref=${SHA}`]: { body: "SECRET=1" },
    });
    const snap = await open({ url: "https://github.com/acme/widgets" });
    expect(snap).toMatchObject({ backend: "github", ref: "main", commit: SHA });
    expect(await snap.listFiles()).toEqual(["src/approve.ts"]);
    expect(await snap.readFile("src/approve.ts")).toBe("export const x = 1;\n");
    expect(await snap.readFile(".env")).toBeNull();
    expect(calls).not.toContain(`/repos/acme/widgets/contents/.env?ref=${SHA}`);
  });

  it("uses the configured ref", async () => {
    mockGitHub({
      "/repos/acme/widgets": { body: { default_branch: "main" } },
      "/repos/acme/widgets/commits/release": { body: { sha: SHA } },
    });
    expect(await open({ url: "acme/widgets", ref: "release" })).toMatchObject({
      ref: "release",
      commit: SHA,
    });
  });

  it("says a private repo needs a token", async () => {
    mockGitHub({});
    const out = await openSourceRepo({ url: "https://github.com/acme/secret-repo" });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("GITHUB_TOKEN") });
    expect(!out.ok && out.error).toContain("private");
  });

  it("says when the ref does not exist", async () => {
    mockGitHub({ "/repos/acme/widgets": { body: { default_branch: "main" } } });
    expect(await openSourceRepo({ url: "acme/widgets", ref: "gone" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("'gone'"),
    });
  });
});
