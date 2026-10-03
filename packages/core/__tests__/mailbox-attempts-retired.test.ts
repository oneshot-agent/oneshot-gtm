import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// Mailbox replies live in outbound_sends since ledger v11. The old
// mailbox_attempts table is left in place for one release, unread: only the
// v11 migration that copies it may name it.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ALLOWED = new Set(["packages/core/src/ledger-schema.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

it("nothing outside the v11 migration reads mailbox_attempts", () => {
  const readers = [...sources(join(ROOT, "packages")), ...sources(join(ROOT, "apps"))]
    .map((path) => relative(ROOT, path))
    .filter((path) => !ALLOWED.has(path))
    .filter((path) => readFileSync(join(ROOT, path), "utf8").includes("mailbox_attempts"));
  expect(readers).toEqual([]);
});
