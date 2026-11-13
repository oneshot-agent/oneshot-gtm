import {
  currentWorkspaceName,
  demoMode,
  getLedger,
  getReplyReviewStore,
  learningKeyOf,
  linkedinWriterOf,
  loadConfig,
  logEvent,
  outcomeAngleText,
  qualifyingAngles,
  type QualifiedAngle,
} from "@oneshot-gtm/core";
import type { LearningChannel } from "@oneshot-gtm/shared-types";
import { proposePreference, type ProposeRun } from "./reply-learning.ts";

/**
 * Reply-based content suggestions (source `outcome`). Writing style is
 * learned from how the founder writes (`reply-learning.ts`); what to argue
 * is suggested only when replies back it: a configured angle that clearly
 * out-replies its play's other angles on one channel and drafting stage
 * (`qualifyingAngles`) becomes one pending "lead with" preference in that
 * area's reply-based slot, `pref:<channel>:<stage>:replies`, beside the
 * style one so neither pushes the other out. The usual proposal rules
 * apply: one pending per area (a newer one supersedes), the expiry sweep,
 * 10 new sends since the area's last proposal or decision, no repeat of a
 * dismissed, retired or near-duplicate text. No model call and no spend:
 * a few ledger reads, at most once a day.
 */

const OUTCOME_JOB = "preference-outcome";
export const OUTCOME_COOLDOWN_MS = 86_400_000;
const LEASE_MS = 60_000;

const asChannel = (c: string): LearningChannel | null =>
  c === "email" || c === "linkedin" ? c : null;

const where = (channel: LearningChannel, stage: QualifiedAngle["stage"]) =>
  `${channel === "email" ? "email" : "LinkedIn"} ${stage === "first_touch" ? "first touches" : "follow-ups"}`;

/** The evidence line a founder reads: the reply counts on both sides. */
export function outcomeSummary(a: QualifiedAngle, channel: LearningChannel): string {
  return `${a.replied} of ${a.reached} replied on this angle, against ${a.otherReplied} of ${a.otherReached} on the play's other angles (${a.playName}, ${where(channel, a.stage)}).`;
}

/** Scheduler-only, daily: propose at most one reply-backed angle per channel and stage. */
export function refreshOutcomeLearning(now = Date.now()): number {
  if (demoMode()) return 0;
  const workspace = currentWorkspaceName();
  // The workspace's learning pause covers every source, this one included.
  if (!getReplyReviewStore().learning.status(workspace).enabled) return 0;
  const ledger = getLedger();
  const token = ledger.learning.claimJob(OUTCOME_JOB, now, {
    cooldownMs: OUTCOME_COOLDOWN_MS,
    leaseMs: LEASE_MS,
  });
  if (!token) return 0;
  try {
    const run: ProposeRun = {
      excluded: new Set(ledger.learning.excludedPreferenceTexts()),
      proposedAreas: new Set(),
      templatedLinkedIn: linkedinWriterOf(loadConfig()) === "template",
      newSends: (area, since) =>
        area.channel && (area.stage === "first_touch" || area.stage === "follow_up")
          ? ledger.learning.draftEvidenceSendsSince(area.channel, area.stage, since, {
              unattended: true,
            })
          : 0,
    };
    let proposed = 0;
    const qualified = qualifyingAngles(ledger.angleOutcomesByStage());
    // Best first: when the best angle in an area was already raised, the next one may still go.
    for (const a of qualified) {
      const channel = asChannel(a.channel);
      if (!channel) continue;
      const result = proposePreference(
        ledger,
        {
          key: `lead-with-${learningKeyOf(a.angleKey)}`,
          instruction: `When the research supports it, lead with: ${outcomeAngleText(a.angleText)}`,
          source: "outcome",
          channel,
          stage: a.stage,
          basis: "replies",
          evidence: {
            refs: a.repliedVersionIds.slice(0, 50).map((id) => ({ type: "draft_version", id })),
            samples: [{ label: "Angle", text: a.angleText, channel, stage: a.stage }],
            counts: {
              reached: a.reached,
              replied: a.replied,
              otherReached: a.otherReached,
              otherReplied: a.otherReplied,
              p: Math.round(a.p * 1000) / 1000,
            },
            method: "outcome",
          },
          summary: outcomeSummary(a, channel),
        },
        run,
      );
      if (result === "inserted") proposed++;
    }
    ledger.learning.finishJob(OUTCOME_JOB, token, { now: new Date(now).toISOString() });
    logEvent("learning.outcome.refreshed", {
      workspace,
      qualified: qualified.length,
      proposed,
    });
    return proposed;
  } catch {
    ledger.learning.failJob(OUTCOME_JOB, token, "Could not refresh reply-based suggestions.");
    logEvent("learning.outcome.failed", { workspace }, "warn");
    return 0;
  }
}
