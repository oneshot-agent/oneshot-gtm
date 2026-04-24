import open from "open";
import { getLedger, logEvent } from "@oneshot-gtm/core";
import { MAX_RUN_AGE_MS } from "@oneshot-gtm/find";
import { buildFetchHandler, SERVER_BASE_OPTS, startServer } from "./server.ts";

// Runtime guard: this binary depends on Bun (bun:sqlite, Bun.serve, Bun.stdin).
// If invoked under plain node, fail loudly with an install hint.
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  process.stderr.write(
    "oneshot-gtm-server requires the Bun runtime.\n" +
      "Install:  curl -fsSL https://bun.sh/install | bash\n" +
      "Re-run:   bunx oneshot-gtm-server\n",
  );
  process.exit(1);
}

const port = Number.parseInt(process.env["PORT"] ?? "3030", 10);
const noBrowser = process.env["ONESHOT_GTM_NO_BROWSER"] === "1";

// Cache the server on globalThis so Bun's `--hot` re-execution (same
// process) can swap handlers via `server.reload({fetch})` instead of
// rebinding the port, which would fail with EADDRINUSE.
type BunServer = Awaited<ReturnType<typeof startServer>>["server"];
const cache = globalThis as { __oneshotGtmServer?: BunServer };

if (cache.__oneshotGtmServer) {
  cache.__oneshotGtmServer.reload({
    ...SERVER_BASE_OPTS,
    fetch: buildFetchHandler(),
  });
  process.stdout.write(`\n  oneshot-gtm dashboard: http://127.0.0.1:${port}  (reloaded)\n\n`);
} else {
  // Cold boot only — sweep any trigger rows that were marked running by a
  // previous process that never got to call updateTriggerLastPoll
  // (bun --watch re-exec, OS reboot, OOM kill). Writes a `killed_by_restart`
  // last_run_summary so the UI shows the truth instead of frozen-from-an-
  // hour-ago state. Hot reload (the if-branch above) preserves the event
  // loop, so any genuinely in-flight run continues and shouldn't be swept.
  //
  // Wrapped — a SQL hiccup here must not take down the server. Boot
  // continuing on stale ledger state is strictly better than refusing to
  // start because of a cleanup detail.
  try {
    const swept = getLedger().sweepStaleRunningTriggers({
      now: new Date(),
      maxAgeMs: MAX_RUN_AGE_MS,
    });
    for (const s of swept) {
      logEvent("trigger.killed_by_restart", { name: s.name, age_ms: s.ageMs }, "warn");
      process.stdout.write(`  swept stale run: ${s.name} (${Math.round(s.ageMs / 1000)}s old)\n`);
    }
  } catch (err) {
    logEvent(
      "trigger.sweep.failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    process.stderr.write(`  warn: stale-run sweep failed: ${(err as Error).message}\n`);
  }

  const { url, server } = await startServer({ port });
  cache.__oneshotGtmServer = server;

  process.stdout.write(`\n  oneshot-gtm dashboard: ${url}\n\n`);

  if (!noBrowser) {
    try {
      await open(url);
    } catch {
      // ignore — terminal output already shows the URL.
    }
  }

  const shutdown = (): void => {
    process.stdout.write("\n  shutting down...\n");
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
