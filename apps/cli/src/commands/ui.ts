import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { c, fail, header, note, ok } from "../output.ts";

interface UiOpts {
  port: number;
  noBrowser: boolean;
  dev: boolean;
}

function locateRepoRoot(): string {
  // apps/cli/src/commands/ui.ts → repo root is 4 levels up
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

export async function commandUi(opts: UiOpts): Promise<void> {
  header(`oneshot-gtm ui ${opts.dev ? c.dim("(dev — vite + server)") : ""}`);

  const root = locateRepoRoot();
  const serverBin = join(root, "apps", "server", "src", "bin.ts");
  const webDist = join(root, "apps", "web", "dist", "index.html");

  if (!opts.dev && !existsSync(webDist)) {
    fail(`web build not found at ${webDist}`);
    note(
      `Run: ${c.cyan("bun run --cwd apps/web build")} (one-time), or pass --dev to use the vite dev server.`,
    );
    process.exit(1);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    ...(opts.noBrowser ? { ONESHOT_GTM_NO_BROWSER: "1" } : {}),
  };

  if (opts.dev) {
    note(`Starting Vite dev (5173) + API server (${opts.port})...`);
    env["VITE_DEV_SERVER_URL"] = "http://127.0.0.1:5173";

    const vite = spawn("bun", ["run", "--cwd", join(root, "apps", "web"), "dev"], {
      stdio: "inherit",
      env,
    });
    // --hot makes Bun re-evaluate the entrypoint (and its imports) on file
    // change within the same process, and — unlike --watch — preserves
    // `globalThis` across reloads. `bin.ts` caches the Bun.serve instance
    // there and calls `server.reload({fetch})` on re-entry to swap handlers
    // without rebinding the port (which would fail with EADDRINUSE).
    const server = spawn("bun", ["--hot", "run", serverBin], {
      stdio: "inherit",
      env: { ...env, ONESHOT_GTM_NO_BROWSER: "1" },
    });

    const shutdown = (): void => {
      vite.kill("SIGTERM");
      server.kill("SIGTERM");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    ok(`Web: http://127.0.0.1:5173    API: http://127.0.0.1:${opts.port}/api`);
    return new Promise<void>(() => {
      // never resolve; handlers above will exit on signal
    });
  }

  // Production-ish: server serves the prebuilt static + API
  const server = spawn("bun", ["run", serverBin], { stdio: "inherit", env });
  const shutdown = (): void => {
    server.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<void>(() => {
    // never resolve; child handles its own SIGINT printing
  });
}
