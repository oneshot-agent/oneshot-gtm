import { PLAYS } from "@oneshot-gtm/plays";
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
 * regenerate endpoint (single-target dry-run). Throws on unsupported plays.
 */
export async function dispatchPlay(playName: string, body: RunPlayRequest): Promise<DraftedView[]> {
  const play = PLAYS[playName];
  if (!play) {
    throw new Error(`unsupported play: ${playName}`);
  }

  const result = await play.run({
    dryRun: body.dryRun,
    targets: body.targets,
    ...(body.senderCohort ? { senderCohort: body.senderCohort } : {}),
    ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
  });
  return result.drafted.map(toDraftedView);
}
