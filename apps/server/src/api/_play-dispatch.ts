import {
  runAcceleratorBatch,
  runCompetitorSwitch,
  runHiringSignal,
  runJobChange,
  runPodcastGuest,
  runPostFunding,
  runShowHn,
  runStackConsolidation,
  type AcceleratorBatchTarget,
  type CompetitorSwitchTarget,
  type HiringSignalTarget,
  type JobChangeTarget,
  type PodcastGuestTarget,
  type PostFundingTarget,
  type ShowHnTarget,
  type StackConsolidationTarget,
} from "@oneshot-gtm/plays";
import type { RunPlayRequest } from "@oneshot-gtm/shared-types";

export interface DraftedView {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
}

export function toDraftedView(d: {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
}): DraftedView {
  return {
    subject: d.subject,
    body: d.body,
    flags: d.flags,
    receiptIds: d.receiptIds,
    sent: d.sent,
  };
}

/**
 * Dispatch a play by name and return one DraftedView per target (in order).
 * Shared by the SSE /api/run endpoint (multi-target) and the /queue
 * regenerate endpoint (single-target dry-run). Throws on unsupported plays
 * and on accelerator-batch without a senderCohort.
 */
export async function dispatchPlay(playName: string, body: RunPlayRequest): Promise<DraftedView[]> {
  switch (playName) {
    case "show-hn": {
      const result = await runShowHn({
        dryRun: body.dryRun,
        targets: body.targets as ShowHnTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "job-change": {
      const result = await runJobChange({
        dryRun: body.dryRun,
        targets: body.targets as JobChangeTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "post-funding": {
      const result = await runPostFunding({
        dryRun: body.dryRun,
        targets: body.targets as PostFundingTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "accelerator-batch": {
      if (!body.senderCohort || body.senderCohort.length === 0) {
        throw new Error("accelerator-batch requires senderCohort");
      }
      const result = await runAcceleratorBatch({
        dryRun: body.dryRun,
        targets: body.targets as AcceleratorBatchTarget[],
        senderCohort: body.senderCohort,
        ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
      });
      return result.drafted.map(toDraftedView);
    }
    case "hiring-signal": {
      const result = await runHiringSignal({
        dryRun: body.dryRun,
        targets: body.targets as HiringSignalTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "podcast-guest": {
      const result = await runPodcastGuest({
        dryRun: body.dryRun,
        targets: body.targets as PodcastGuestTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "competitor-switch": {
      const result = await runCompetitorSwitch({
        dryRun: body.dryRun,
        targets: body.targets as CompetitorSwitchTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "stack-consolidation": {
      const result = await runStackConsolidation({
        dryRun: body.dryRun,
        targets: body.targets as StackConsolidationTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    default:
      throw new Error(`unsupported play: ${playName}`);
  }
}
