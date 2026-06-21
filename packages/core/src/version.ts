import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the `version` from the caller's package.json so `--version` output and
 * the telemetry `version` field can't drift from the published release.
 *
 * Pass `import.meta.url`. The assumption — true for both current callers
 * (`apps/cli/src/index.ts`, `apps/server/src/telemetry.ts`) — is that the
 * calling file sits one directory under its package root, so `../package.json`
 * relative to the file's directory is the package manifest. Any failure
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
