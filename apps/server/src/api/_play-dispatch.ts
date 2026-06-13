import { PLAYS } from "@oneshot-gtm/plays";
import type { RunPlayRequest } from "@oneshot-gtm/shared-types";

export interface DraftedView {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
  enrichmentFailed?: boolean;
}

export function toDraftedView(d: {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
  enrichmentFailed?: boolean;
}): DraftedView {
  return {
    subject: d.subject,
    body: d.body,
    flags: d.flags,
    receiptIds: d.receiptIds,
    sent: d.sent,
    ...(d.enrichmentFailed ? { enrichmentFailed: true } : {}),
  };
}

/**
 * Dispatch a play by name and return one DraftedView per target (in order).
 * Shared by the SSE /api/run endpoint (multi-target) and the /queue
 * regenerate endpoint (single-target dry-run). Throws on unsupported plays.
 *
 * `onProgress`: optional per-target hook fired AFTER each target completes.
 * The SSE handler uses this to emit `draft` + `send` events live as they
 * happen instead of batching at the end. The PlayDraft → DraftedView
 * projection is applied inside the wrapper so the callback gets the same
 * shape downstream code expects.
 */
export async function dispatchPlay(
  playName: string,
  body: RunPlayRequest,
  onProgress?: (index: number, view: DraftedView) => void,
): Promise<DraftedView[]> {
  const play = PLAYS[playName];
  if (!play) {
    throw new Error(`unsupported play: ${playName}`);
  }

  const result = await play.run({
    dryRun: body.dryRun,
    targets: body.targets,
    ...(body.senderCohort ? { senderCohort: body.senderCohort } : {}),
    ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
    ...(onProgress
      ? {
          onProgress: (index: number, draft: Parameters<typeof toDraftedView>[0]) =>
            onProgress(index, toDraftedView(draft)),
        }
      : {}),
  });
  return result.drafted.map(toDraftedView);
}
