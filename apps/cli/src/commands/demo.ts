import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENV_ONLY_SECRET_KEYS, SECRET_KEYS } from "@oneshot-gtm/core";
import { bail, c, header, note, ok, warn } from "../output.ts";
import {
  canonicalize,
  DEFAULT_DEMO_HOME,
  DEMO_MARKER,
  DemoSeedError,
  resetDemoHome,
  seedDemoHome,
} from "../demo/seed.ts";
import { commandUi } from "./ui.ts";

/**
 * Strip every real credential from an env before it reaches the demo server.
 * core's `applySecretsToEnv()` fills blank env vars from the REAL home's .env
 * at import time, and the spawned child's loader only fills vars still blank —
 * so without this scrub the inherited real keys would SHADOW the demo home's
 * placeholders and a demo "Send" could spend real money. Also drops every
 * env-only credential (GITHUB_TOKEN, the X keys, …), which live only in env.
 */
export function scrubInheritedSecrets(env: NodeJS.ProcessEnv): void {
  for (const key of [...SECRET_KEYS, ...ENV_ONLY_SECRET_KEYS]) {
    delete env[key];
  }
}

interface SeedOpts {
  home: string;
  now?: string;
  force: boolean;
}

export async function commandDemoSeed(opts: SeedOpts): Promise<void> {
  header("oneshot-gtm demo seed");

  let anchor: Date | undefined;
  if (opts.now) {
    const parsed = new Date(opts.now);
    if (Number.isNaN(parsed.getTime())) {
      bail(`--now must be a parseable date (got "${opts.now}")`);
    }
    anchor = parsed;
  }

  let result;
  try {
    result = seedDemoHome({ home: opts.home, force: opts.force, ...(anchor ? { anchor } : {}) });
  } catch (err) {
    if (err instanceof DemoSeedError) bail(err.message);
    throw err;
  }

  const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
  ok(`seeded ${total} rows into ${c.cyan(result.home)}`);
  for (const [table, n] of Object.entries(result.counts)) {
    note(`  ${table.padEnd(20)} ${n}`);
  }
  note("");
  note(`Anchored at ${result.anchor.toISOString()} — re-seed with the same ${c.cyan("--now")} to`);
  note("reproduce this ledger exactly, so a re-shoot matches an earlier take.");
  note("");
  ok(`Launch it:  ${c.cyan("bun run cli -- demo ui")}`);
  warn("Placeholder credentials — clicking Run or Send in the demo fails at auth by design.");
}

interface DemoUiOpts {
  home: string;
  port: number;
  noBrowser: boolean;
  dev: boolean;
}

export async function commandDemoUi(opts: DemoUiOpts): Promise<void> {
  // Canonicalized (symlinks followed), and required to carry the seed marker.
  // Without the marker check, `demo ui --home ~/.oneshot-gtm` — or a symlink
  // pointing there — would launch the REAL install under the demo flag: real
  // credentials behind a UI the operator believes is fake.
  const home = canonicalize(opts.home);
  if (!existsSync(home)) {
    bail(`no demo home at ${home}. Run ${c.cyan("bun run cli -- demo seed")} first.`);
  }
  if (!existsSync(join(home, DEMO_MARKER))) {
    bail(
      `${home} has no ${DEMO_MARKER} marker — not a seeded demo install. ` +
        `demo ui refuses to run a real install under the demo flag.`,
    );
  }

  // `commandUi` spawns the server with `...process.env`, so mutating it here
  // redirects the whole child process at the demo install. The scrub comes
  // first — see its doc comment: without it, real credentials inherited at
  // core-import time shadow the demo home's placeholders in the child.
  scrubInheritedSecrets(process.env);
  process.env["ONESHOT_GTM_HOME"] = home;
  process.env["ONESHOT_GTM_DEMO"] = "1";
  // Not a workspace: the shim may have set a real one, and the demo's masthead
  // and touch attribution must not claim to be it.
  process.env["ONESHOT_GTM_WORKSPACE"] = "demo";
  // The shared cross-workspace DB must not leak real caches/touches into a
  // demo, nor record the demo's clicks as real contact history.
  process.env["ONESHOT_GTM_SHARED"] = join(home, "shared");
  // A demo run is not a real install and must not report itself as one.
  process.env["ONESHOT_GTM_TELEMETRY"] = "0";

  note(`demo home: ${c.cyan(home)}  ·  scheduler idle, network reads served from fixtures`);
  await commandUi({ port: opts.port, noBrowser: opts.noBrowser, dev: opts.dev });
}

export async function commandDemoReset(opts: { home: string }): Promise<void> {
  header("oneshot-gtm demo reset");
  const home = canonicalize(opts.home);
  try {
    resetDemoHome(home);
  } catch (err) {
    if (err instanceof DemoSeedError) bail(err.message);
    throw err;
  }
  ok(`removed ${c.cyan(home)}`);
}

export { DEFAULT_DEMO_HOME };
