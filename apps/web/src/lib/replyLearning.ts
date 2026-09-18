import { REPLY_VARIANTS } from "@oneshot-gtm/shared-types";
import type { ReplyDraftSet, ReplyVariant, ReplyLearningStatus } from "@oneshot-gtm/shared-types";

export function adoptReplyImprovement(
  draft: ReplyDraftSet,
  variant: ReplyVariant,
  text: string,
  improvementId?: string,
): ReplyDraftSet {
  return {
    ...draft,
    selected: variant,
    edits: { ...draft.edits, [variant]: text },
    improvementIds: {
      ...draft.improvementIds,
      [variant]: improvementId
        ? [...(draft.improvementIds?.[variant] ?? []), improvementId].slice(-20)
        : (draft.improvementIds?.[variant] ?? []),
    },
  };
}
export function replyLearningSummary(status: ReplyLearningStatus): string {
  if (!status.enabled) return "Learning is paused. Saved preferences are not used in new drafts.";
  if (status.error) return status.error;
  if (!status.imported || status.pending)
    return "Learning from confirmed replies. New preferences will appear after the next refresh.";
  if (!status.preferences.some((p) => p.enabled))
    return "No active preferences yet. Repeated edits and general feedback on sent replies help establish your style.";
  return "Applied to new LinkedIn suggestions in this workspace. Your current instructions always take priority.";
}

/** Server normalization must not turn an unchanged draft into another autosave. */
export const replyDraftFingerprint = (d: ReplyDraftSet): string =>
  JSON.stringify([
    d.id,
    d.edits,
    d.selected,
    d.steer,
    d.contextVersion,
    REPLY_VARIANTS.map((v) => d.improvementIds?.[v] ?? []),
  ]);
