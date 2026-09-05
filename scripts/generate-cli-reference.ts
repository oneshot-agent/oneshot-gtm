import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { referenceMatches, renderCliReference } from "../apps/cli/src/docs-reference.ts";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputArg = args[outputIndex + 1];
if (
  outputIndex < 0 ||
  !outputArg ||
  outputArg.startsWith("--") ||
  args.some((arg, i) => i !== outputIndex && i !== outputIndex + 1 && arg !== "--check")
) {
  throw new Error("Usage: bun run scripts/generate-cli-reference.ts --output <file.mdx> [--check]");
}
// Imports may initialize config. Keep documentation generation out of real workspaces.
const home = mkdtempSync(resolve(tmpdir(), "gtm-docs-"));
process.env["ONESHOT_GTM_HOME"] = home;
process.env["ONESHOT_GTM_SHARED"] = resolve(home, "shared");
process.env["ONESHOT_GTM_TELEMETRY"] = "0";
process.env["ONESHOT_GTM_CLI_NO_PARSE"] = "1";
const { program } = await import("../apps/cli/src/index.ts");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: resolve(import.meta.dirname, ".."),
  encoding: "utf8",
}).trim();
const expected = renderCliReference(program, revision);
const output = resolve(outputArg);
if (args.includes("--check")) {
  if (!referenceMatches(readFileSync(output, "utf8"), expected))
    throw new Error(`CLI reference is stale: ${output}. Regenerate it from this checkout.`);
  console.log("CLI reference matches the command tree.");
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, expected);
  console.log(`Generated ${output}`);
}
