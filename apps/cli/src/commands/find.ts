import { drainQueue, nextSleepMs, runDueTriggers, type FinderResult } from "@oneshot-gtm/find";
import { bail, bailEmpty, c, fail, header, note, ok } from "../output.ts";

export async function commandFindDrain(opts: {
  play: string;
  limit?: number;
  dryRun: boolean;
  senderCohort?: string;
  offer?: string;
  failOnEmpty?: boolean;
}): Promise<void> {
  header(`find drain ${opts.play} ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const result = await drainQueue({
    playName: opts.play,
    limit: opts.limit ?? 10,
    dryRun: opts.dryRun,
    ...(opts.senderCohort ? { senderCohort: opts.senderCohort } : {}),
    ...(opts.offer ? { freeForCohortOffer: opts.offer } : {}),
  });
  if (result.drained === 0) {
    note(`No approved rows for ${c.cyan(opts.play)}. Approve some in the dashboard at /queue.`);
    // Nothing was claimed, so there is nothing that could have errored — an
    // empty drain under the flag is always the idle case, never the broken one.
    if (opts.failOnEmpty) bailEmpty(`find drain ${opts.play}: 0 rows drained`);
    return;
  }
  ok(`drained ${result.drained} row(s); ${result.sent} ${opts.dryRun ? "would be sent" : "sent"}.`);
  if (result.errors.length > 0) {
    for (const e of result.errors) fail(`#${e.id}: ${e.message}`);
    // Error beats emptiness: a caller that opted into exit-code signalling gets
    // 1 for a drain that hit row errors, not the 0 a clean drain returns.
    if (opts.failOnEmpty) bail(`find drain ${opts.play}: ${result.errors.length} row(s) errored`);
  }
}

export async function commandFindWatch(opts: {
  once: boolean;
  quiet: boolean;
  failOnEmpty?: boolean;
}): Promise<void> {
  header(`find watch ${opts.once ? c.dim("(--once)") : c.dim("(daemon)")}`);
  let cancelled = false;
  let wake: (() => void) | null = null;
  const shutdown = (): void => {
    cancelled = true;
    process.stdout.write(`\n${c.dim("watch: shutting down...")}\n`);
    if (wake) wake();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // State of the most recent tick. Only --once reads it; the daemon reports
  // each error and keeps polling (one flaky finder must not stop the others).
  let errored = 0;
  let queued = 0;
  let firedNames: string[] = [];
  try {
    for (;;) {
      const outcomes = await runDueTriggers();
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
