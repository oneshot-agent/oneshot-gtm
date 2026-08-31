import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// Where the shipped prompt files live. Mirrors the resolution order in
// ../src/prompts.ts so this test finds the same directory the loader does.
const promptsDir = [
  join(here, "..", "..", "prompts"),
  join(here, "..", "..", "..", "prompts"),
  join(process.cwd(), "packages", "prompts"),
].find((dir) => existsSync(dir));

// Repo root — the ancestor holding `packages` and `apps`. From
// packages/intel/__tests__ that is three levels up.
const repoRoot = join(here, "..", "..", "..");

// Deliberate orphans: prompt files that ship but no `loadPrompt` path reaches.
// Every entry needs a one-line reason so the gate stays honest — an unexplained
// orphan is exactly the fork-editing-a-dead-file bug this test exists to catch.
const ALLOWED_ORPHANS: Record<string, string> = {
  "agent-builder-extract":
    "Repo-README vendor extractor for an unshipped GitHub-stack email; superseded by the stack-consolidation play. Kept as a drafted prompt, wired to no caller yet.",
};

// Source trees that can call loadPrompt. Prompt names are strings the loader
// receives, so we recover them from the source rather than by running it.
const SOURCE_ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".worktrees"]);

function sourceFiles(root: string): string[] {
  const abs = join(repoRoot, root);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // `parentPath` is the documented field; `path` is the older alias. Node
    // populates one of them, so read through a cast that allows both.
    const loc = entry as unknown as { parentPath?: string; path?: string };
    const dir = loc.parentPath ?? loc.path ?? abs;
    const full = join(dir, entry.name);
    // Match SKIP_DIRS against the path *inside* the scanned root only. The
    // absolute prefix can legitimately contain a skip name — a git worktree
    // lives under `.worktrees/<id>/`, so checking `full` would drop every file.
    const rel = relative(abs, full);
    if (rel.split(/[/\\]/).some((seg) => SKIP_DIRS.has(seg))) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    // Test files reference prompt names (e.g. to exercise the loader) but are
    // not callers — counting them would mask a genuine orphan.
    if (/\.test\.tsx?$/.test(entry.name) || rel.split(/[/\\]/).includes("__tests__")) continue;
    out.push(full);
  }
  return out;
}

// Literal prompt names handed to the loader, directly or via a play's
// `promptName:` (both flow into loadPrompt). These are the "loadable names".
const LITERAL_PATTERNS = [
  /loadPrompt\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g,
  /promptName:\s*["'`]([A-Za-z0-9_-]+)["'`]/g,
];
// Play names — a play draws its prompt from `${play}` (loadPrompt(PLAY_NAME))
// or the derived `${play}-email` / `${play}-followup` shapes.
const PLAY_PATTERNS = [
  /PLAY_NAME\s*=\s*["'`]([A-Za-z0-9_-]+)["'`]/g,
  /playName:\s*["'`]([A-Za-z0-9_-]+)["'`]/g,
];
// Prompt names loaded through a variable or template rather than a string
// literal, e.g. `loadPrompt(PLAY_NAME)` or `loadPrompt(`${PLAY_NAME}-email`)`.
// These resolve to a concrete loadable name via the referenced const's value,
// so a deleted file behind one must still trip the missing-file check — the
// name must not depend on the file's own existence to be counted as loadable.
const DYNAMIC_BARE_RE = /loadPrompt\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
const DYNAMIC_TEMPLATE_RE = /loadPrompt\(\s*`\$\{\s*([A-Za-z_$][\w$]*)\s*\}([A-Za-z0-9_-]*)`\s*\)/g;
// `const NAME = "value"` / `let` / `var` — used to resolve the identifier a
// dynamic loadPrompt call references back to its string value, within a file.
const STRING_CONST_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([A-Za-z0-9_-]+)["'`]/g;

function collect(): {
  literalNames: Set<string>;
  playNames: Set<string>;
  dynamicNames: Set<string>;
} {
  const literalNames = new Set<string>();
  const playNames = new Set<string>();
  const dynamicNames = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, "utf8");
      for (const re of LITERAL_PATTERNS) {
        for (const m of src.matchAll(re)) if (m[1]) literalNames.add(m[1]);
      }
      for (const re of PLAY_PATTERNS) {
        for (const m of src.matchAll(re)) if (m[1]) playNames.add(m[1]);
      }
      // Resolve dynamic loadPrompt calls against the file's own string consts.
      // Whole file is scanned for consts first, so definition/use order is moot.
      const consts = new Map<string, string>();
      for (const m of src.matchAll(STRING_CONST_RE)) if (m[1] && m[2]) consts.set(m[1], m[2]);
      for (const m of src.matchAll(DYNAMIC_BARE_RE)) {
        const value = m[1] && consts.get(m[1]);
        if (value) dynamicNames.add(value);
      }
      for (const m of src.matchAll(DYNAMIC_TEMPLATE_RE)) {
        const value = m[1] && consts.get(m[1]);
        if (value) dynamicNames.add(`${value}${m[2] ?? ""}`);
      }
    }
  }
  return { literalNames, playNames, dynamicNames };
}

function promptFileNames(): string[] {
  if (!promptsDir) throw new Error("packages/prompts directory not found");
  return readdirSync(promptsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .toSorted();
}

describe("prompt inventory — files and loadable names stay in sync", () => {
  const files = promptFileNames();
  const { literalNames, playNames, dynamicNames } = collect();

  // The loadable names: every name some loadPrompt path can resolve. Literal
  // names plus dynamically resolved ones (`loadPrompt(PLAY_NAME)` and the
  // `${play}-email` / `${play}-followup` template shapes) — resolved from the
  // call site, NOT gated on the file existing, so a deleted file behind a
  // dynamic load still fails the no-file check below.
  const loadableNames = new Set([...literalNames, ...dynamicNames]);
  const fileSet = new Set(files);

  // Reachability for the orphan direction. Every loadable name is reachable;
  // play-derived shapes are added when a matching file exists so a file that a
  // known play could draw from isn't misflagged as an orphan.
  const reachable = new Set(loadableNames);
  for (const play of playNames) {
    for (const candidate of [play, `${play}-email`, `${play}-followup`]) {
      if (fileSet.has(candidate)) reachable.add(candidate);
    }
  }

  it("finds prompt files and loadable names to compare", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(literalNames.size).toBeGreaterThan(0);
    expect(playNames.size).toBeGreaterThan(0);
  });

  it("every loadable name has a backing file", () => {
    const missing = [...loadableNames].filter((name) => !fileSet.has(name)).toSorted();
    expect(
      missing,
      `loadPrompt names with no packages/prompts/*.md file: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every prompt file is reachable or an explained orphan", () => {
    const orphans = files
      .filter((name) => !reachable.has(name) && !(name in ALLOWED_ORPHANS))
      .toSorted();
    expect(
      orphans,
      `orphan prompt files (add a caller or an allow-list reason): ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("every allow-listed orphan is still an orphan (prune stale entries)", () => {
    const wired = Object.keys(ALLOWED_ORPHANS)
      .filter((name) => reachable.has(name))
      .toSorted();
    expect(
      wired,
      `allow-listed orphans now wired to a caller — drop from ALLOWED_ORPHANS: ${wired.join(", ")}`,
    ).toEqual([]);
  });

  it("every allow-listed orphan file still exists (prune deleted entries)", () => {
    const gone = Object.keys(ALLOWED_ORPHANS)
      .filter((name) => !fileSet.has(name))
      .toSorted();
    expect(
      gone,
      `allow-listed orphans with no file — drop from ALLOWED_ORPHANS: ${gone.join(", ")}`,
    ).toEqual([]);
  });

  it("every allow-list reason is a non-empty line", () => {
    for (const [name, reason] of Object.entries(ALLOWED_ORPHANS)) {
      expect(reason.trim().length, `allow-list entry ${name} needs a reason`).toBeGreaterThan(0);
    }
  });
});
