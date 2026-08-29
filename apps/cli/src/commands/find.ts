import {
  drainQueue,
  nextSleepMs,
  runDueTriggers,
  type FinderResult,
  type TriggerRunOutcome,
} from "@oneshot-gtm/find";
import {
  bail,
  bailEmpty,
  c,
  emitJson,
  fail,
  header,
  human,
  note,
  ok,
  setJsonMode,
} from "../output.ts";

export async function commandFindDrain(opts: {
  play: string;
  limit?: number;
  dryRun: boolean;
  senderCohort?: string;
  offer?: string;
  failOnEmpty?: boolean;
  json?: boolean;
}): Promise<void> {
  setJsonMode(opts.json ?? false);
  header(`find drain ${opts.play} ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const result = await drainQueue({
    playName: opts.play,
    limit: opts.limit ?? 10,
    dryRun: opts.dryRun,
    ...(opts.senderCohort ? { senderCohort: opts.senderCohort } : {}),
    ...(opts.offer ? { freeForCohortOffer: opts.offer } : {}),
  });
  // The document is emitted BEFORE any bail below, so `--json` still explains a
  // non-zero exit rather than being swallowed by it. The exit code stays the
  // health signal; the JSON says why.
  if (opts.json) {
    emitJson({
      command: "find drain",
      play: opts.play,
      dryRun: opts.dryRun,
      drained: result.drained,
      sent: result.sent,
      deferred: result.deferred,
      errors: result.errors.map((e) => ({ id: e.id, message: e.message })),
    });
  }

  // Errors beat emptiness: a drain with row errors (or an invalid play) exits 1,
  // not the 0 a clean drain returns nor the 2 an idle drain under --fail-on-empty
  // returns. Check this before checking drained === 0, so an invalid play with no
  // approved rows exits 1 (unsupported-play error) instead of 2 (empty drain).
  if (result.errors.length > 0) {
    for (const e of result.errors) fail(`#${e.id}: ${e.message}`);
    if (opts.failOnEmpty) bail(`find drain ${opts.play}: ${result.errors.length} row(s) errored`);
    // Without the flag, a drain with errors still exits 0 (the legacy behavior).
  }

  if (result.drained === 0) {
    note(`No approved rows for ${c.cyan(opts.play)}. Approve some in the dashboard at /queue.`);
    // Nothing was claimed, and we already checked that there were no errors, so
    // this is the idle case, never the broken one.
    if (opts.failOnEmpty) bailEmpty(`find drain ${opts.play}: 0 rows drained`);
    return;
  }
  ok(`drained ${result.drained} row(s); ${result.sent} ${opts.dryRun ? "would be sent" : "sent"}.`);
}

export async function commandFindWatch(opts: {
  once: boolean;
  quiet: boolean;
  failOnEmpty?: boolean;
  json?: boolean;
}): Promise<void> {
  setJsonMode(opts.json ?? false);
  header(`find watch ${opts.once ? c.dim("(--once)") : c.dim("(daemon)")}`);
  let cancelled = false;
  let wake: (() => void) | null = null;
  const shutdown = (): void => {
    cancelled = true;
    human(`\n${c.dim("watch: shutting down...")}\n`);
    if (wake) wake();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // State of the most recent tick. Only --once reads it; the daemon reports
  // each error and keeps polling (one flaky finder must not stop the others).
  let errored = 0;
  let queued = 0;
  let firedNames: string[] = [];
  // Outcomes of the last tick, kept for the --json document (--once only).
  let lastTick: TriggerRunOutcome[] = [];
  try {
    for (;;) {
      const outcomes = await runDueTriggers();
      lastTick = outcomes;
      errored = 0;
      queued = 0;
      firedNames = [];
      for (const o of outcomes) {
        if (!o.fired) {
          if (!opts.quiet) note(`${o.name}: skipped (next due in ${humanMs(o.nextDueInMs)})`);
          continue;
        }
        firedNames.push(o.name);
        if (o.error !== undefined) {
          errored++;
          fail(`${o.name}: error — ${o.error}`);
        } else if (o.result) {
          // `enqueued`, not `candidates`: the question --fail-on-empty answers
          // is "did anything land in the queue", and a run whose every hit was
          // a duplicate or off-ICP left the ledger exactly as it found it.
          queued += o.result.enqueued;
          printSummaryLine(o.name, o.result);
        }
      }

      if (opts.once || cancelled) break;
      const sleepMs = nextSleepMs(outcomes);
      if (!opts.quiet) note(`watch: sleeping ${humanMs(sleepMs)}`);
      await sleepCancellable(sleepMs, (cancel) => {
        wake = cancel;
      });
      wake = null;
      if (cancelled) break;
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  // Emitted before the bail below so the document lands on stdout even on the
  // exit-1 path — the exit code stays the health signal, JSON explains it.
  if (opts.json) {
    emitJson({
      command: "find watch",
      ok: errored === 0,
      errored,
      triggers: lastTick.map((o) => ({
        name: o.name,
        fired: o.fired,
        nextDueInMs: o.nextDueInMs,
        ...(o.duration_ms != null ? { durationMs: o.duration_ms } : {}),
        ...(o.error !== undefined ? { error: o.error } : {}),
        ...(o.result ? { result: jsonFinderResult(o.result) } : {}),
      })),
    });
  }

  // --once is the cron/launchd entry point, where the exit code is the only
  // health signal there is: a finder that errored every run for a week must not
  // look identical to a clean one. Daemon runs still exit 0 — they're killed by
  // a signal, not by a bad tick.
  if (opts.once && errored > 0) {
    bail(`${errored} due trigger(s) errored`);
  }

  // Opt-in second signal for the same caller: a poll that ran cleanly but
  // queued nothing exits 2, so cron can tell a dry run from a productive one
  // without reading the ledger. The error check above runs first on purpose —
  // a broken run reports as broken (1) even though it was also empty.
  if (opts.once && opts.failOnEmpty && queued === 0) {
    bailEmpty(
      `find watch --once: 0 candidates queued (${
        firedNames.length > 0 ? `triggers: ${firedNames.join(", ")}` : "no triggers due"
      })`,
    );
  }
}

/** FinderResult in the flag's camelCase contract, optionals normalized to 0. */
function jsonFinderResult(r: FinderResult): Record<string, unknown> {
  return {
    source: r.source,
    candidates: r.candidates,
    enqueued: r.enqueued,
    droppedIcp: r.droppedIcp,
    droppedRole: r.droppedRole ?? 0,
    droppedDuplicate: r.droppedDuplicate,
    droppedEnrichment: r.droppedEnrichment,
    droppedLowSignal: r.droppedLowSignal ?? 0,
    costUsd: r.costUsd,
    ...(r.halted ? { halted: r.halted } : {}),
  };
}

function printSummaryLine(name: string, r: FinderResult): void {
  ok(
    `${name}: candidates=${r.candidates} kept=${r.enqueued} icp-dropped=${r.droppedIcp} role-dropped=${r.droppedRole ?? 0} dup=${r.droppedDuplicate} enrich-failed=${r.droppedEnrichment} cost=$${r.costUsd.toFixed(2)}${r.halted ? ` (halted: ${r.halted})` : ""}`,
  );
}

/**
 * Resolves after `ms` OR when the registered cancel function is called.
 * Lets SIGINT/SIGTERM short-circuit a long sleep so `find watch` exits
 * promptly instead of blocking until the next poll window.
 */
function sleepCancellable(ms: number, register: (cancel: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    register(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}
