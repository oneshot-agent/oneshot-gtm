import { PLAYS, type ProspectOffer } from "@oneshot-gtm/plays";
import type { DraftAngle, RunPlayRequest } from "@oneshot-gtm/shared-types";

export interface DraftedView {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
  enrichmentFailed?: boolean;
  originalTargetIndex?: number;
  /** Which edge angle the play built the draft on (see `PlayDraft.angle`). */
  angle?: DraftAngle;
  /** Hash of the founder's voice card in the prompt (see `PlayDraft.voiceKey`). */
  voiceKey?: string | null;
  /** Fingerprint of the approved learned-guidance set in the prompt (#813); absent when none applied. */
  learningKey?: string | null;
  /** First-touch format arm (see `PlayDraft.formatKey`). */
  formatKey?: string | null;
  /** LinkedIn note only: whether its prompt carried an evidence clause (#792). */
  evidenceClause?: boolean;
  /** LinkedIn only: a known connection, so the draft is no note (`DraftedRow.knownConnection`). */
  knownConnection?: { readAt: string };
  /** The offer the draft opens with (see `PlayDraft.offer`). */
  offer?: ProspectOffer;
  /** The ranked set, only when the draft wrote its offer: the run stores it on the target's queue row. */
  offerCandidates?: ProspectOffer[];
}

export function toDraftedView(d: {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
  enrichmentFailed?: boolean;
  originalTargetIndex?: number;
  angle?: DraftAngle;
  voiceKey?: string | null;
  /** Fingerprint of the approved learned-guidance set in the prompt (#813); absent when none applied. */
  learningKey?: string | null;
  formatKey?: string | null;
  evidenceClause?: boolean;
  offer?: ProspectOffer;
  offerCandidates?: ProspectOffer[];
}): DraftedView {
  return {
    subject: d.subject,
    body: d.body,
    flags: d.flags,
    receiptIds: d.receiptIds,
    sent: d.sent,
    ...(d.enrichmentFailed ? { enrichmentFailed: true } : {}),
    ...(d.originalTargetIndex !== undefined ? { originalTargetIndex: d.originalTargetIndex } : {}),
    ...(d.angle ? { angle: d.angle } : {}),
    ...(d.voiceKey ? { voiceKey: d.voiceKey } : {}),
    ...(d.learningKey ? { learningKey: d.learningKey } : {}),
    ...(d.formatKey ? { formatKey: d.formatKey } : {}),
    ...(d.evidenceClause !== undefined ? { evidenceClause: d.evidenceClause } : {}),
    ...(d.offer ? { offer: d.offer } : {}),
    ...(d.offerCandidates ? { offerCandidates: d.offerCandidates } : {}),
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
 * a partial batch. The drafts already finished were reported via `onProgress`.
 *
 * `queueSource`: the `source` of the queue row being redrafted (the /queue
 * regenerate endpoint), so the play reads that row's trigger settings (the
 * `multiplier` play's `memberOffer`) the way the queue drain does. Absent for
 * /api/run, which hands `queueSources` instead: per target, the source of
 * the queue row it was loaded from (by its dedupe key), null for a manual
 * row, so each row of a mixed batch reads its own trigger's settings.
 * `queueIds` are those rows' ids, aligned with `queueSources`: a sequence a
 * send starts links the row it came from.
 */
export async function dispatchPlay(
  playName: string,
  body: RunPlayRequest,
  onProgress?: (index: number, view: DraftedView) => void,
  signal?: AbortSignal,
  draftAngle?: string,
  queueSource?: string | null,
  queueSources?: ReadonlyArray<string | null>,
  queueIds?: ReadonlyArray<number | null>,
): Promise<DraftedView[]> {
  const play = PLAYS[playName];
  if (!play) {
    throw new Error(`unsupported play: ${playName}`);
  }

  const result = await play.run({
    ...(draftAngle ? { draftAngle } : {}),
    ...(queueSource !== undefined ? { queueSource } : {}),
    ...(queueSources ? { queueSources } : {}),
    ...(queueIds ? { queueIds } : {}),
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
