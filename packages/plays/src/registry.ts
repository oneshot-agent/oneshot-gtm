import { type AcceleratorBatchTarget, runAcceleratorBatch } from "./accelerator-batch.ts";
import { type BreakupReviveTarget, runBreakupRevive } from "./breakup-revive.ts";
import { type CompetitorSwitchTarget, runCompetitorSwitch } from "./competitor-switch.ts";
import { type HiringSignalTarget, runHiringSignal } from "./hiring-signal.ts";
import { type JobChangeTarget, runJobChange } from "./job-change.ts";
import { type LumaEventsTarget, runLumaEvents } from "./luma-events.ts";
import { type PodcastGuestTarget, runPodcastGuest } from "./podcast-guest.ts";
import { type PostFundingTarget, runPostFunding } from "./post-funding.ts";
import { type ProfileIntroTarget, runProfileIntro } from "./profile-intro.ts";
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
  /** Enrichment SDK failed — draft built from payload only (non-blocking; surfaced on /queue). */
  enrichmentFailed?: boolean;
}

/** Run-level options a play may consume. `targets` is play-specific JSON. */
export interface PlayRunInput {
  dryRun: boolean;
  targets: unknown[];
  /** Required by accelerator-batch. */
  senderCohort?: string;
  freeForCohortOffer?: string;
  /**
   * Optional per-target progress callback. Fires AFTER each target's full
   * prepare → draft → lint → send chain resolves (in completion order, not
   * input order). The /api/run SSE handler installs this so the UI's
   * counters tick from 0/N → N/N as targets finish, instead of jumping at
   * the end. Plays that don't use `runEmailPlay` (e.g. breakup-revive's
   * custom loop) silently ignore this field — they still work, just without
   * live ticks.
   */
  onProgress?: (index: number, draft: DraftedRow) => void;
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
// All onProgress callbacks are DraftedRow-typed; the per-play wrappers'
// own draft types (RepoInterestDraft, ShowHnDraft, …) all structurally
// satisfy DraftedRow, so the cast inside each forward is safe.
type PlayProgressFn = (index: number, draft: DraftedRow) => void;
const progressOpt = (o: PlayRunInput): { onProgress?: PlayProgressFn } =>
  o.onProgress ? { onProgress: o.onProgress } : {};

export const PLAYS: Record<string, PlayDispatch> = {
  "show-hn": {
    run: (o) =>
      runShowHn({
        dryRun: o.dryRun,
        targets: o.targets as ShowHnTarget[],
        ...progressOpt(o),
      }),
  },
  "job-change": {
    run: (o) =>
      runJobChange({
        dryRun: o.dryRun,
        targets: o.targets as JobChangeTarget[],
        ...progressOpt(o),
      }),
  },
  "post-funding": {
    run: (o) =>
      runPostFunding({
        dryRun: o.dryRun,
        targets: o.targets as PostFundingTarget[],
        ...progressOpt(o),
      }),
  },
  "accelerator-batch": {
    run: (o) =>
      runAcceleratorBatch({
        dryRun: o.dryRun,
        targets: o.targets as AcceleratorBatchTarget[],
        // Run-level fallback for manual /run targets; finder rows carry their own.
        ...(o.senderCohort ? { senderCohort: o.senderCohort } : {}),
        ...(o.freeForCohortOffer ? { freeForCohortOffer: o.freeForCohortOffer } : {}),
        ...progressOpt(o),
      }),
  },
  "hiring-signal": {
    run: (o) =>
      runHiringSignal({
        dryRun: o.dryRun,
        targets: o.targets as HiringSignalTarget[],
        ...progressOpt(o),
      }),
  },
  "podcast-guest": {
    run: (o) =>
      runPodcastGuest({
        dryRun: o.dryRun,
        targets: o.targets as PodcastGuestTarget[],
        ...progressOpt(o),
      }),
  },
  "competitor-switch": {
    run: (o) =>
      runCompetitorSwitch({
        dryRun: o.dryRun,
        targets: o.targets as CompetitorSwitchTarget[],
        ...progressOpt(o),
      }),
  },
  "stack-consolidation": {
    run: (o) =>
      runStackConsolidation({
        dryRun: o.dryRun,
        targets: o.targets as StackConsolidationTarget[],
        ...progressOpt(o),
      }),
  },
  "repo-interest": {
    run: (o) =>
      runRepoInterest({
        dryRun: o.dryRun,
        targets: o.targets as RepoInterestTarget[],
        ...progressOpt(o),
      }),
  },
  "luma-events": {
    run: (o) =>
      runLumaEvents({
        dryRun: o.dryRun,
        targets: o.targets as LumaEventsTarget[],
        ...progressOpt(o),
      }),
  },
  "profile-intro": {
    run: (o) =>
      runProfileIntro({
        dryRun: o.dryRun,
        targets: o.targets as ProfileIntroTarget[],
        ...progressOpt(o),
      }),
  },
  "breakup-revive": {
    // Custom loop (not runEmailPlay). Silently ignores onProgress for now;
    // counters will jump at the end. Acceptable until breakup-revive grows
    // a parallelMap-style worker pool.
    run: (o) => runBreakupRevive({ dryRun: o.dryRun, targets: o.targets as BreakupReviveTarget[] }),
  },
};

export function isSupportedPlay(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLAYS, name);
}
