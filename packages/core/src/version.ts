import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the `version` from the caller's package.json so `--version` output and
 * the telemetry `version` field can't drift from the published release.
 *
 * Pass `import.meta.url` from a file one directory below its package root,
 * as apps/cli/src/index.ts and apps/server/src/telemetry.ts do. The manifest
 * is read from ../package.json relative to that file's directory. Any failure
 * (unexpected layout, unreadable file, missing field) falls back to "0.0.0"
 * rather than throwing.
 */
export function readPackageVersion(metaUrl: string): string {
  try {
    const here = dirname(fileURLToPath(metaUrl));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
