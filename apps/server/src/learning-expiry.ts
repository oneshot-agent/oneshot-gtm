import {
  currentWorkspaceName,
  demoMode,
  getLedger,
  learningExpireAfterDaysOf,
  linkedinWriterOf,
  loadConfig,
  logEvent,
} from "@oneshot-gtm/core";

/**
 * Retire learning proposals nobody will decide (scheduler tick, next to
 * `refreshReplyLearning`). A proposal waiting longer than
 * `learning.expireAfterDays` (default 7), a prospect angle whose prospect
 * has nothing left to draft, and, while LinkedIn copy is templates, a
 * LinkedIn first-touch or follow-up preference no draft would read, go
 * `stale` with the reason in `decided_json`. Stale counts as a dismissal,
 * so none of them is raised again. A few UPDATEs over pending rows: cheap,
 * and a no-op when nothing is due. Returns the number retired.
 */
export function expireLearningProposals(now = Date.now()): number {
  if (demoMode()) return 0;
  const cfg = loadConfig();
  const days = learningExpireAfterDaysOf(cfg);
  const counts = getLedger().learning.expirePending({
    now: new Date(now).toISOString(),
    before: new Date(now - days * 86_400_000).toISOString(),
    templatedLinkedIn: linkedinWriterOf(cfg) === "template",
  });
  const total = counts.expired + counts["sequence-ended"] + counts.template;
  if (total > 0)
    logEvent("learning.proposals.expired", {
      workspace: currentWorkspaceName(),
      expired: counts.expired,
      sequenceEnded: counts["sequence-ended"],
      template: counts.template,
    });
  return total;
}
