#!/usr/bin/env bun
/**
 * Bootstrap shim — the real bin target. core's config.ts captures
 * ONESHOT_GTM_HOME at module load and ESM hoists imports, so the home must be
 * decided and set in env BEFORE importing the CLI proper; this file imports
 * only builtins until then. Resolution: `--workspace` > ONESHOT_GTM_WORKSPACE
 * > registry default; explicit ONESHOT_GTM_HOME wins over all (combining it
 * with --workspace is an error). Children inherit via process.env.
 */
import {
  extractWorkspaceFlag,
  loadRegistry,
  resolveWorkspaceSelection,
  WorkspaceError,
} from "@oneshot-gtm/core/workspaces";

try {
  const { flag, argv } = extractWorkspaceFlag(process.argv.slice(2));
  const selection = resolveWorkspaceSelection({
    flag,
    envWorkspace: process.env["ONESHOT_GTM_WORKSPACE"],
    envHome: process.env["ONESHOT_GTM_HOME"],
    registry: loadRegistry(),
  });
  process.env["ONESHOT_GTM_HOME"] = selection.home;
  process.env["ONESHOT_GTM_WORKSPACE"] = selection.name;
  process.argv = [process.argv[0]!, process.argv[1]!, ...argv];
} catch (err) {
  if (err instanceof WorkspaceError) {
    process.stderr.write(`  ✗ ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

await import("./index.ts");
