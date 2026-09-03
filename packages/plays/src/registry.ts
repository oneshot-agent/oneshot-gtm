import { type AcceleratorBatchTarget, runAcceleratorBatch } from "./accelerator-batch.ts";
import { type BreakupReviveTarget, runBreakupRevive } from "./breakup-revive.ts";
import { type CompetitorSwitchTarget, runCompetitorSwitch } from "./competitor-switch.ts";
import { type FreePilotTarget, runFreePilot } from "./free-pilot.ts";
import { type SourcesSoughtTarget, runSourcesSought } from "./sources-sought.ts";
import { type CivicPilotTarget, runCivicPilot } from "./civic-pilot.ts";
import { type DesignPartnerLoiTarget, runDesignPartnerLoi } from "./design-partner-loi.ts";
import { type HiringSignalTarget, runHiringSignal } from "./hiring-signal.ts";
import { type JobChangeTarget, runJobChange } from "./job-change.ts";
import { type LumaEventsTarget, runLumaEvents } from "./luma-events.ts";
import { type PodcastGuestTarget, runPodcastGuest } from "./podcast-guest.ts";
import { type PostFundingTarget, runPostFunding } from "./post-funding.ts";
import { type ProfileIntroTarget, runProfileIntro } from "./profile-intro.ts";
import { type RepoInterestTarget, runRepoInterest } from "./repo-interest.ts";
import { type ShowHnTarget, runShowHn } from "./show-hn.ts";
import { type StackConsolidationTarget, runStackConsolidation } from "./stack-consolidation.ts";
import { type XAmplifyTarget, runXAmplify } from "./x-amplify.ts";
import { type XAmplifyDmTarget, runXAmplifyDm } from "./x-amplify-dm.ts";
import { type XRepostIntroTarget, runXRepostIntro } from "./x-repost-intro.ts";

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
  /**
   * Cancellation signal for the run. The /api/run SSE handler owns it and
   * aborts on client disconnect or POST /api/run/:runId/cancel; every play
   * checks it at its paid-call boundaries, so an abort stops the spend rather
   * than just abandoning the stream. Callers without a cancel path (CLI, queue
   * drain, scheduler) omit it and the run stays uncancellable, as before.
   */
  signal?: AbortSignal;
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
// Same exactOptionalPropertyTypes dance for the run's cancellation signal:
// spread it in only when the caller supplied one, so plays keep seeing an
// absent field rather than an explicit `undefined`.
const signalOpt = (o: PlayRunInput): { signal?: AbortSignal } =>
  o.signal ? { signal: o.signal } : {};

export const PLAYS: Record<string, PlayDispatch> = {
  "show-hn": {
    run: (o) =>
      runShowHn({
        dryRun: o.dryRun,
        targets: o.targets as ShowHnTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "job-change": {
    run: (o) =>
      runJobChange({
        dryRun: o.dryRun,
        targets: o.targets as JobChangeTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "post-funding": {
    run: (o) =>
      runPostFunding({
        dryRun: o.dryRun,
        targets: o.targets as PostFundingTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
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
        ...signalOpt(o),
      }),
  },
  "hiring-signal": {
    run: (o) =>
      runHiringSignal({
        dryRun: o.dryRun,
        targets: o.targets as HiringSignalTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "podcast-guest": {
    run: (o) =>
      runPodcastGuest({
        dryRun: o.dryRun,
        targets: o.targets as PodcastGuestTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "competitor-switch": {
    run: (o) =>
      runCompetitorSwitch({
        dryRun: o.dryRun,
        targets: o.targets as CompetitorSwitchTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "stack-consolidation": {
    run: (o) =>
      runStackConsolidation({
        dryRun: o.dryRun,
        targets: o.targets as StackConsolidationTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "repo-interest": {
    run: (o) =>
      runRepoInterest({
        dryRun: o.dryRun,
        targets: o.targets as RepoInterestTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "luma-events": {
    run: (o) =>
      runLumaEvents({
        dryRun: o.dryRun,
        targets: o.targets as LumaEventsTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "profile-intro": {
    run: (o) =>
      runProfileIntro({
        dryRun: o.dryRun,
        targets: o.targets as ProfileIntroTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "breakup-revive": {
    // Custom loop (not runEmailPlay).
    run: (o) =>
      runBreakupRevive({
        dryRun: o.dryRun,
        targets: o.targets as BreakupReviveTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "x-repost-intro": {
    run: (o) =>
      runXRepostIntro({
        dryRun: o.dryRun,
        targets: o.targets as XRepostIntroTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "x-amplify": {
    run: (o) =>
      runXAmplify({
        dryRun: o.dryRun,
        targets: o.targets as XAmplifyTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "x-amplify-dm": {
    run: (o) =>
      runXAmplifyDm({
        dryRun: o.dryRun,
        targets: o.targets as XAmplifyDmTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "free-pilot": {
    run: (o) =>
      runFreePilot({
        dryRun: o.dryRun,
        targets: o.targets as FreePilotTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "sources-sought": {
    run: (o) =>
      runSourcesSought({
        dryRun: o.dryRun,
        targets: o.targets as SourcesSoughtTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "civic-pilot": {
    run: (o) =>
      runCivicPilot({
        dryRun: o.dryRun,
        targets: o.targets as CivicPilotTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
  "design-partner-loi": {
    run: (o) =>
      runDesignPartnerLoi({
        dryRun: o.dryRun,
        targets: o.targets as DesignPartnerLoiTarget[],
        ...progressOpt(o),
        ...signalOpt(o),
      }),
  },
};

export function isSupportedPlay(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLAYS, name);
}
