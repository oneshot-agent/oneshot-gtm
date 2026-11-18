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
 * Give this workspace's LinkedIn replies the reply labels email replies get
 * (REPLY_INTENTS), with the same classifier and the workspace's
 * `replyClassifier` config. Only the accounts this workspace owns: the
 * workspace servers share one inbox store, and each would otherwise pay for
 * the same message. An `unsubscribe` label opts the person out on every
 * channel and stops their live cadences where the reply was delivered.
 * Bounded per call; logs failures and never throws.
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
