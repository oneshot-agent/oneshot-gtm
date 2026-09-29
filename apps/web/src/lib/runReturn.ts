type RunMode = "edit" | "progress" | "done" | "interrupted" | "cancelled";

/** Seconds the finished dry run stays on screen before heading back to /queue. */
export const RETURN_TO_QUEUE_SECONDS = 3;

/**
 * A dry run drained from the queue has nothing left to do on /run once it
 * finishes: the drafts are saved onto the approved rows, and review and send
 * happen there. Only a completion watched live counts (progress → done in this
 * mount), so reopening an old `?runId=` never bounces the founder away, and
 * real sends stay put for the "view in cadences" hand-off. A run with errors
 * or no drafts also stays, since the page is the only place those show.
 */
export function shouldReturnToQueue(input: {
  prevMode: RunMode | null;
  mode: RunMode;
  fromQueue: boolean;
  dryRun: boolean;
  drafts: number;
  errors: number;
}): boolean {
  return (
    input.fromQueue &&
    input.dryRun &&
    input.prevMode === "progress" &&
    input.mode === "done" &&
    input.drafts > 0 &&
    input.errors === 0
  );
}

/** "10 drafts ready · 1 lint" for the toast that carries the counts across. */
export function dryRunReturnSummary(drafts: number, flagged: number): string {
  const head = `${drafts} draft${drafts === 1 ? "" : "s"} ready`;
  return flagged > 0 ? `${head} · ${flagged} lint` : head;
}
