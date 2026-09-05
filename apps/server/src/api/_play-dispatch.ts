import { PLAYS } from "@oneshot-gtm/plays";
import type { RunPlayRequest } from "@oneshot-gtm/shared-types";

export interface DraftedView {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
  enrichmentFailed?: boolean;
  originalTargetIndex?: number;
}

export function toDraftedView(d: {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
  enrichmentFailed?: boolean;
  originalTargetIndex?: number;
}): DraftedView {
  return {
    subject: d.subject,
    body: d.body,
    flags: d.flags,
    receiptIds: d.receiptIds,
    sent: d.sent,
    ...(d.enrichmentFailed ? { enrichmentFailed: true } : {}),
    ...(d.originalTargetIndex !== undefined ? { originalTargetIndex: d.originalTargetIndex } : {}),
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
 *
 * `signal`: the run's cancellation signal, forwarded to the play so it can
 * bail at its paid-call boundaries. When it fires mid-run this call rejects
 * with a `RunCancelledError` (see `isRunCancelled`) instead of resolving with
 * a partial batch — the drafts already finished were reported via `onProgress`.
 */
export async function dispatchPlay(
  playName: string,
  body: RunPlayRequest,
  onProgress?: (index: number, view: DraftedView) => void,
  signal?: AbortSignal,
): Promise<DraftedView[]> {
  const play = PLAYS[playName];
  if (!play) {
    throw new Error(`unsupported play: ${playName}`);
  }

  const result = await play.run({
    dryRun: body.dryRun,
    targets: body.targets,
    ...(signal ? { signal } : {}),
    ...(onProgress
      ? {
          onProgress: (index: number, draft: Parameters<typeof toDraftedView>[0]) =>
            onProgress(index, toDraftedView(draft)),
        }
      : {}),
  });
  return result.drafted.map(toDraftedView);
}
