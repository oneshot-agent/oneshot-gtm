import {
  demoMode,
  labelLinkedInReplyBatch,
  logEvent,
  type LinkedInInboxStore,
  type LinkedInLabelResult,
  type LinkedInReplyClassifier,
} from "@oneshot-gtm/core";
import { classifyReplyIntent } from "@oneshot-gtm/intel";
import { stopCadencesForOptOut } from "@oneshot-gtm/plays";

/**
 * Label this workspace's LinkedIn replies with email's reply labels and
 * classifier config. Only accounts this workspace owns: the servers share one
 * store, and each would otherwise pay for the same message. An `unsubscribe`
 * stops the person's live cadences. Bounded per call; logs, never throws.
 */
export async function labelLinkedInReplies(
  opts: { limit?: number; classify?: LinkedInReplyClassifier; store?: LinkedInInboxStore } = {},
): Promise<LinkedInLabelResult | null> {
  if (demoMode()) return null;
  try {
    const out = await labelLinkedInReplyBatch({
      classify: opts.classify ?? ((email) => classifyReplyIntent(email)),
      stopCadences: (ledger, prospectId) => stopCadencesForOptOut(prospectId, ledger, "linkedin"),
      limit: opts.limit ?? 25,
      ...(opts.store ? { store: opts.store } : {}),
    });
    if (out.checked > 0) {
      const { labels: _labels, ...counts } = out;
      logEvent("scheduler.linkedin_intent", counts);
    }
    return out;
  } catch (err) {
    logEvent(
      "scheduler.linkedin_intent.failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}
