import open from "open";
import {
  activeSendCount,
  beginDraining,
  getLedger,
  logEvent,
  waitForSendsToDrain,
} from "@oneshot-gtm/core";
import { buildFetchHandler, SERVER_BASE_OPTS, startServer } from "./server.ts";
import { startScheduler, type SchedulerHandle } from "./scheduler.ts";

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
const cache = globalThis as {
  __oneshotGtmServer?: BunServer;
  __oneshotGtmScheduler?: SchedulerHandle;
};

if (cache.__oneshotGtmServer) {
  // Hot reload: keep the existing scheduler running. The reloaded module
  // graph picks up source changes on its next tick (5s-1h away).
  cache.__oneshotGtmServer.reload({
    ...SERVER_BASE_OPTS,
    fetch: buildFetchHandler(),
  });
  process.stdout.write(`\n  oneshot-gtm dashboard: http://127.0.0.1:${port}  (reloaded)\n\n`);
} else {
  // Cold boot only (hot reload preserves the event loop, so in-flight runs
  // continue) — sweep trigger rows left marked running by a dead process.
  // `maxAgeMs: 0` is intentional and important: at cold boot any non-null
  // `running_started_at` is a zombie; applying the 4h UI freshness gate here
  // would block re-runs with `409 already running`. Wrapped — a SQL hiccup
  // must not take down the server.
  try {
    const swept = getLedger().sweepStaleRunningTriggers({
      now: new Date(),
      maxAgeMs: 0,
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

  // Same sweep for cadence sends: a pre-boot `sending_started_at` marker is
  // cleared whether the send landed (sequence_events row exists) or was lost
  // mid-SDK-call (draft survives for a re-click); both cases are logged.
  try {
    const swept = getLedger().sweepStaleCadenceSends({
      now: new Date(),
      maxAgeMs: 0,
    });
    for (const s of swept) {
      logEvent(
        s.actuallySent ? "cadence.send.cleared_marker" : "cadence.send.killed_by_restart",
        {
          prospect_id: s.prospectId,
          play_name: s.playName,
          age_ms: s.ageMs,
          actually_sent: s.actuallySent,
        },
        s.actuallySent ? "info" : "warn",
      );
      if (!s.actuallySent) {
        process.stdout.write(
          `  swept stale cadence send: ${s.playName} (prospect ${s.prospectId}, ${Math.round(s.ageMs / 1000)}s old) — re-click Send to retry\n`,
        );
      }
    }
  } catch (err) {
    logEvent(
      "cadence.send.sweep_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    process.stderr.write(`  warn: stale-send sweep failed: ${(err as Error).message}\n`);
  }

  // Mirror of the cadence sweep for `target_queue.send_started_at` — cold
  // boot wipes every existing marker; drafts survive for retry.
  try {
    const swept = getLedger().sweepStaleQueueSends({
      now: new Date(),
      maxAgeMs: 0,
    });
    for (const s of swept) {
      logEvent(
        s.actuallySent ? "queue.send.cleared_marker" : "queue.send.killed_by_restart",
        {
          queue_id: s.id,
          age_ms: s.ageMs,
          actually_sent: s.actuallySent,
        },
        s.actuallySent ? "info" : "warn",
      );
      if (!s.actuallySent) {
        process.stdout.write(
          `  swept stale queue send: row ${s.id} (${Math.round(s.ageMs / 1000)}s old) — re-click Send to retry\n`,
        );
      }
    }
  } catch (err) {
    logEvent(
      "queue.send.sweep_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    process.stderr.write(`  warn: stale queue-send sweep failed: ${(err as Error).message}\n`);
  }

  // Cold-boot sweep for /run dispatches: flip zombie 'running' rows to
  // 'interrupted'; per-event counters on the row stay accurate.
  try {
    const swept = getLedger().sweepStaleRuns({ now: new Date(), maxAgeMs: 0 });
    for (const s of swept) {
      logEvent(
        "run.killed_by_restart",
        { run_id: s.id, play_name: s.playName, age_ms: s.ageMs },
        "warn",
      );
      process.stdout.write(
        `  swept stale run: #${s.id} ${s.playName} (${Math.round(s.ageMs / 1000)}s old)\n`,
      );
    }
  } catch (err) {
    logEvent(
      "run.sweep_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    process.stderr.write(`  warn: stale-run sweep failed: ${(err as Error).message}\n`);
  }

  const { url, server } = await startServer({ port });
  cache.__oneshotGtmServer = server;

  // Background trigger scheduler; survives `bun --hot` re-execs via the
  // globalThis anchor. Wrapped: scheduler init failure must not take down
  // the server (triggers can still be run manually via /queue Run).
  let scheduler: SchedulerHandle | null = null;
  try {
    scheduler = startScheduler();
    cache.__oneshotGtmScheduler = scheduler;
  } catch (err) {
    logEvent(
      "scheduler.start.failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "error",
    );
    process.stderr.write(`  warn: scheduler failed to start: ${(err as Error).message}\n`);
  }

  process.stdout.write(`\n  oneshot-gtm dashboard: ${url}\n\n`);

  if (!noBrowser) {
    try {
      await open(url);
    } catch {
      // ignore — terminal output already shows the URL.
    }
  }

  // Graceful drain: on a signal, wait for in-flight sends to finish writing
  // their sequence_events rows — closes the sent-but-unrecorded re-send
  // window. SIGKILL skips this; the cold-boot sweep is the backstop.
  const drainTimeoutMs = Number.parseInt(
    process.env["ONESHOT_GTM_DRAIN_TIMEOUT_MS"] ?? "30000",
    10,
  );
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // Second signal while draining → the operator wants out now. Honor it.
    if (shuttingDown) {
      process.stdout.write("\n  forced exit.\n");
      process.exit(1);
    }
    shuttingDown = true;
    beginDraining();
    if (scheduler) scheduler.stop();
    const inflight = activeSendCount();
    if (inflight > 0) {
      process.stdout.write(
        `\n  ${signal} — draining ${inflight} in-flight send(s)... (Ctrl-C again to force)\n`,
      );
      const { drained, remaining } = await waitForSendsToDrain({ timeoutMs: drainTimeoutMs });
      if (drained) {
        process.stdout.write("  drained — all sends recorded.\n");
      } else {
        logEvent("server.drain.timeout", { remaining, timeout_ms: drainTimeoutMs }, "warn");
        process.stdout.write(
          `  WARN: ${remaining} send(s) still in-flight after ${drainTimeoutMs}ms — exiting; boot sweep will reconcile.\n`,
        );
      }
    } else {
      process.stdout.write("\n  shutting down...\n");
    }
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
