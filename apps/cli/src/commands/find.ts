import { drainQueue, nextSleepMs, runDueTriggers, type FinderResult } from "@oneshot-gtm/find";
import { c, fail, header, note, ok } from "../output.ts";

export async function commandFindDrain(opts: {
  play: string;
  limit?: number;
  dryRun: boolean;
  senderCohort?: string;
  offer?: string;
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
    return;
  }
  ok(`drained ${result.drained} row(s); ${result.sent} ${opts.dryRun ? "would be sent" : "sent"}.`);
  if (result.errors.length > 0) {
    for (const e of result.errors) fail(`#${e.id}: ${e.message}`);
  }
}

export async function commandFindWatch(opts: { once: boolean; quiet: boolean }): Promise<void> {
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

  for (;;) {
    const outcomes = await runDueTriggers();
    for (const o of outcomes) {
      if (!o.fired) {
        if (!opts.quiet) note(`${o.name}: skipped (next due in ${humanMs(o.nextDueInMs)})`);
        continue;
      }
      if (o.error) {
        fail(`${o.name}: error — ${o.error}`);
      } else if (o.result) {
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
}

function printSummaryLine(name: string, r: FinderResult): void {
  ok(
    `${name}: candidates=${r.candidates} kept=${r.enqueued} icp-dropped=${r.droppedIcp} dup=${r.droppedDuplicate} enrich-failed=${r.droppedEnrichment} cost=$${r.costUsd.toFixed(2)}${r.halted ? ` (halted: ${r.halted})` : ""}`,
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
