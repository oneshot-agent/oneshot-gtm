import { type AcceleratorBatchTarget, runAcceleratorBatch } from "./accelerator-batch.ts";
import { type BreakupReviveTarget, runBreakupRevive } from "./breakup-revive.ts";
import { type CompetitorSwitchTarget, runCompetitorSwitch } from "./competitor-switch.ts";
import { type HiringSignalTarget, runHiringSignal } from "./hiring-signal.ts";
import { type JobChangeTarget, runJobChange } from "./job-change.ts";
import { type PodcastGuestTarget, runPodcastGuest } from "./podcast-guest.ts";
import { type PostFundingTarget, runPostFunding } from "./post-funding.ts";
import { type RepoInterestTarget, runRepoInterest } from "./repo-interest.ts";
import { type ShowHnTarget, runShowHn } from "./show-hn.ts";
import { type StackConsolidationTarget, runStackConsolidation } from "./stack-consolidation.ts";

/**
 * The fields every play runner's drafted row exposes. Callers (the SSE /run
 * endpoint and the queue drainer) read only these — `target`/`scrapedEvidence`/
 * `jobPostHook`/etc. are extra and ignored here.
 */
export interface DraftedRow {
  subject: string;
  body: string;
  flags: string[];
  sent: boolean;
  receiptIds: number[];
}

/** Run-level options a play may consume. `targets` is play-specific JSON. */
export interface PlayRunInput {
  dryRun: boolean;
  targets: unknown[];
  /** Required by accelerator-batch. */
  senderCohort?: string;
  freeForCohortOffer?: string;
}

export interface PlayDispatch {
  run: (o: PlayRunInput) => Promise<{ drafted: DraftedRow[] }>;
}

/**
 * Single source of truth mapping a play name → its runner. Both the server's
 * `/api/run` dispatch and the queue drainer look plays up here, so adding a
 * play means registering it once (its file + this table) instead of editing
 * two parallel switch statements that silently drifted apart.
 */
export const PLAYS: Record<string, PlayDispatch> = {
  "show-hn": {
    run: (o) => runShowHn({ dryRun: o.dryRun, targets: o.targets as ShowHnTarget[] }),
  },
  "job-change": {
    run: (o) => runJobChange({ dryRun: o.dryRun, targets: o.targets as JobChangeTarget[] }),
  },
  "post-funding": {
    run: (o) => runPostFunding({ dryRun: o.dryRun, targets: o.targets as PostFundingTarget[] }),
  },
  "accelerator-batch": {
    run: (o) =>
      runAcceleratorBatch({
        dryRun: o.dryRun,
        targets: o.targets as AcceleratorBatchTarget[],
        // Run-level fallback for manual /run targets; finder rows carry their own.
        ...(o.senderCohort ? { senderCohort: o.senderCohort } : {}),
        ...(o.freeForCohortOffer ? { freeForCohortOffer: o.freeForCohortOffer } : {}),
      }),
  },
  "hiring-signal": {
    run: (o) => runHiringSignal({ dryRun: o.dryRun, targets: o.targets as HiringSignalTarget[] }),
  },
  "podcast-guest": {
    run: (o) => runPodcastGuest({ dryRun: o.dryRun, targets: o.targets as PodcastGuestTarget[] }),
  },
  "competitor-switch": {
    run: (o) =>
      runCompetitorSwitch({ dryRun: o.dryRun, targets: o.targets as CompetitorSwitchTarget[] }),
  },
  "stack-consolidation": {
    run: (o) =>
      runStackConsolidation({ dryRun: o.dryRun, targets: o.targets as StackConsolidationTarget[] }),
  },
  "repo-interest": {
    run: (o) => runRepoInterest({ dryRun: o.dryRun, targets: o.targets as RepoInterestTarget[] }),
  },
  "breakup-revive": {
    run: (o) => runBreakupRevive({ dryRun: o.dryRun, targets: o.targets as BreakupReviveTarget[] }),
  },
};

export function isSupportedPlay(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLAYS, name);
}
