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
  // Cold boot only — sweep any trigger rows that were marked running by a
  // previous process that never got to call updateTriggerLastPoll
  // (bun --watch re-exec, OS reboot, OOM kill, hung SDK call when the
  // process was killed). Writes a `killed_by_restart` last_run_summary so
  // the UI shows the truth instead of frozen-from-an-hour-ago state.
  //
  // `maxAgeMs: 0` is intentional and important. At cold boot, any non-null
  // `running_started_at` is by definition a zombie — the previous process is
  // gone and an async finder run can't outlive its process. The MAX_RUN_AGE_MS
  // freshness gate (4h) is for live UI reads where a long-running finder
  // shouldn't disappear from the spinner mid-run. Applying it to the boot
  // sweep would let a row that crashed 30 minutes ago survive across reboots
  // and block re-runs with `409 already running` — exactly the bug we hit.
  //
  // Hot reload (the if-branch above) skips the sweep because it preserves
  // the event loop, so any genuinely in-flight run continues.
  //
  // Wrapped — a SQL hiccup here must not take down the server. Boot
  // continuing on stale ledger state is strictly better than refusing to
  // start because of a cleanup detail.
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

  // Same idea for fire-and-forget cadence sends. Any cadence_state row whose
  // `sending_started_at` predates this process was either (a) the previous
  // process succeeded — in which case the sequence_events row landed and the
  // sweep just clears the now-meaningless marker, or (b) the previous process
  // died mid-SDK-call — in which case the marker is stranded, the draft is
  // still there, and the founder can re-click Send. The sweeper logs both
  // cases so the founder can see "send was lost" in events.jsonl.
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
    process.stderr.write(
      `  warn: stale-send sweep failed: ${(err as Error).message}\n`,
    );
  }

  // Mirror of the cadence sweep for `target_queue.send_started_at`. A queue
  // row with a marker from a previous process either (a) had its SDK call
  // complete before the kill — `status === 'sent'`, we just clear the marker —
  // or (b) was stranded mid-call — clear the marker, the draft is still on the
  // row for retry. Either way: cold boot wipes every existing marker.
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
    process.stderr.write(
      `  warn: stale queue-send sweep failed: ${(err as Error).message}\n`,
    );
  }

  // Cold-boot sweep for /run dispatches: any run still marked 'running' from
  // a previous process is a zombie — the SSE stream is gone, the dispatch was
  // killed. Flipping to 'interrupted' lets the /run page show a truthful
  // banner instead of an eternal "running" view. Counters on the row are
  // already accurate from the per-event appends, so the founder still sees
  // what landed before the crash.
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

  // Background trigger scheduler — polls due triggers, fires them, sleeps
  // for `nextSleepMs` between ticks. Replaces the need to run a separate
  // `bun run cli -- find watch` daemon. Survives `bun --hot` re-execs by
  // staying anchored to globalThis.
  //
  // Wrapped: scheduler init failure must not take down the server (founder
  // can still drive triggers manually via /queue Run). The cold-boot sweep
  // pattern above does the same thing for ledger-init resilience.
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

  // Graceful drain: on a signal, stop taking new sends and wait for any
  // in-flight send to finish writing its sequence_events row before exiting —
  // closing the window where a sent-but-unrecorded email could be re-sent on
  // retry. A SIGKILL skips this; the cold-boot sweep above is the backstop.
  // Default 30s; a long voice call past that is force-exited and reconciled.
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
