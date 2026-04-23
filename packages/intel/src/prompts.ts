import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  join(here, "..", "..", "prompts"),
  join(here, "..", "..", "..", "prompts"),
  join(process.cwd(), "packages", "prompts"),
];

export function loadPrompt(name: string): string {
  // Reject any path-traversal attempt. Prompt names are always hardcoded
  // identifiers in this codebase (e.g. "personalize", "advise"); rejecting
  // anything else is defense-in-depth in case a future caller passes user
  // input through.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`invalid prompt name: ${JSON.stringify(name)}`);
  }
  for (const dir of candidates) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`prompt not found: ${name}.md (searched: ${candidates.join(", ")})`);
}
