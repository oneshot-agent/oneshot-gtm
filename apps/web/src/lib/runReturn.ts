import type { RunStatus } from "@oneshot-gtm/shared-types";

/** Seconds the finished dry run stays on screen before heading back to /queue. */
export const RETURN_TO_QUEUE_SECONDS = 3;

/**
 * A dry run drained from the queue has nothing left to do on /run once it
 * finishes: the drafts are saved onto the approved rows, and review and send
 * happen there. It only counts when this mount watched the run live (started
 * it, or saw its record while running), so reopening an old `?runId=` never
 * bounces the founder away; the record's loading state is not evidence.
 * Real sends stay put for the "view in cadences" hand-off. A run with errors,
 * no drafts, or a hand-added row (no queue row to hold its draft) also stays,
 * since the page is the only place those show.
 */
export function shouldReturnToQueue(input: {
  watchedLive: boolean;
  status: RunStatus | null;
  fromQueue: boolean;
  dryRun: boolean;
  drafts: number;
  errors: number;
  allLinked: boolean;
}): boolean {
  return (
    input.watchedLive &&
    input.status === "done" &&
    input.fromQueue &&
    input.dryRun &&
    input.drafts > 0 &&
    input.errors === 0 &&
    input.allLinked
  );
}

/** Every target maps to a queue row, so every draft landed where /queue shows it. */
export function allTargetsLinked(
  targetCount: number,
  dedupeKeys: ReadonlyArray<string | null>,
): boolean {
  return (
    targetCount > 0 &&
    dedupeKeys.length === targetCount &&
    dedupeKeys.every((k) => typeof k === "string" && k.length > 0)
  );
}

/** "10 drafts ready · 1 lint" for the toast that carries the counts across. */
export function dryRunReturnSummary(drafts: number, flagged: number): string {
  const head = `${drafts} draft${drafts === 1 ? "" : "s"} ready`;
  return flagged > 0 ? `${head} · ${flagged} lint` : head;
}
