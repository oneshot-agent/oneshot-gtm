#!/usr/bin/env bun
/**
 * Bootstrap shim — the real bin target.
 *
 * core's config.ts captures ONESHOT_GTM_HOME at module load and auto-loads
 * that home's .env on import, and ESM hoists imports, so by the time commander
 * could parse a `--workspace` flag the install is already chosen. This file
 * therefore imports only node builtins and the builtin-only workspaces module,
 * decides the home, sets the env, and only THEN imports the CLI proper.
 *
 * Resolution: `--workspace <name>` > ONESHOT_GTM_WORKSPACE > registry default.
 * An explicit ONESHOT_GTM_HOME wins over all of them (and combining it with
 * --workspace is an error). Every child this process spawns (the dashboard
 * server) inherits the decision through process.env.
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
