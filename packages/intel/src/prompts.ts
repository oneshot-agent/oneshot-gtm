import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  join(here, "..", "..", "prompts"),
  join(here, "..", "..", "..", "prompts"),
  join(process.cwd(), "packages", "prompts"),
];

// Matches the bracketed reference line prompt files use to point at the
// humanizer doc: `[See _humanizer.md — every rule binding...]`. The `[^\]]*`
// (non-greedy through the close-bracket) avoids any chance of consuming a
// downstream `]` if a prompt accidentally has another bracket on the line.
const HUMANIZER_REF_RE = /^\[See _humanizer\.md[^\]]*\]\s*$/gm;

let humanizerCache: string | null = null;

function readPromptFile(name: string): string | null {
  for (const dir of candidates) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

function loadHumanizer(): string {
  if (humanizerCache != null) return humanizerCache;
  const content = readPromptFile("_humanizer");
  if (content == null) {
    throw new Error(`_humanizer.md not found in any of: ${candidates.join(", ")}`);
  }
  humanizerCache = content.trimEnd();
  return humanizerCache;
}

export function loadPrompt(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`invalid prompt name: ${JSON.stringify(name)}`);
  }
  const raw = readPromptFile(name);
  if (raw == null) {
    throw new Error(`prompt not found: ${name}.md (searched: ${candidates.join(", ")})`);
  }
  // The textual `[See _humanizer.md ...]` reference in many prompts was a
  // false promise: the LLM read "see X" but the content was never attached.
  // Inline it here so every prompt that opts in (by including the reference)
  // actually receives the humanizer rules.
  if (HUMANIZER_REF_RE.test(raw)) {
    return raw.replace(HUMANIZER_REF_RE, loadHumanizer());
  }
  return raw;
}

/** Test-only: clears the memoized humanizer read. Not used in production. */
export function _resetPromptCache(): void {
  humanizerCache = null;
}
