/**
 * The /cadences row's second line (issue #602): where this person is in the
 * sequence, in one mono label — "step 2 of 4 · sent 3d ago · next in 1d",
 * "replied on linkedin · 2d ago", "stopped · not a fit · 5d ago". Pure: the
 * clock is injected so the cases are testable, and the label uppercases in
 * the row, so the text here is plain case.
 */
import type { CadenceStopReason, CadenceView } from "@oneshot-gtm/shared-types";
import { timeAgo } from "./cn.ts";

export const STOP_REASON_LABELS: Record<CadenceStopReason, string> = {
  bad_timing: "bad timing / revisit later",
  other: "other",
  not_a_fit: "not a fit",
  do_not_contact: "do not contact",
};

export type CadenceStateTone = "muted" | "spend" | "blocked" | "receipt";

export interface CadenceState {
  text: string;
  tone: CadenceStateTone;
}

const join = (parts: Array<string | null | undefined>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" · ");

export function cadenceStateLabel(c: CadenceView, now: Date): CadenceState {
  const nowMs = now.getTime();
  const ago = (iso: string): string => timeAgo(iso, nowMs);
  const total = c.followupCount + 1;
  const step = `step ${Math.min(c.currentStep + 1, total)} of ${total}`;
  const lastSent = c.priorSteps.at(-1)?.sentAt ?? null;

  if (c.isSending) return { text: join([step, "sending…"]), tone: "receipt" };

  switch (c.status) {
    case "replied":
      return {
        text: join([
          `replied${c.replyChannel ? ` on ${c.replyChannel}` : ""}`,
          c.replyAt ? ago(c.replyAt) : null,
        ]),
        tone: "receipt",
      };
    case "stopped":
      return {
        text: join([
          "stopped",
          c.stopReason ? STOP_REASON_LABELS[c.stopReason] : "reason unavailable",
          c.stoppedAt ? ago(c.stoppedAt) : null,
        ]),
        tone: "blocked",
      };
    case "bounced":
    case "unsubscribed": {
      const at = c.stoppedAt ?? lastSent;
      return { text: join([c.status, at ? ago(at) : null]), tone: "blocked" };
    }
    case "breakup":
      return { text: join(["breakup sent", lastSent ? ago(lastSent) : null]), tone: "spend" };
    case "completed":
      return {
        text: join(["completed", `${total} of ${total}`, lastSent ? ago(lastSent) : null]),
        tone: "muted",
      };
    case "paused":
      return { text: join(["paused", step]), tone: "muted" };
    case "active": {
      const parts: string[] = [
        step,
        lastSent ? `sent ${ago(lastSent)}` : `enrolled ${ago(c.enrolledAt)}`,
      ];
      let tone: CadenceStateTone = "muted";
      if (c.nextDueAt == null) {
        if (c.nextStepLabel == null) parts.push("no steps left");
      } else if (new Date(c.nextDueAt).getTime() <= nowMs) {
        parts.push(`overdue · due ${ago(c.nextDueAt)}`);
        tone = "spend";
      } else {
        parts.push(`next ${ago(c.nextDueAt)}`);
      }
      if (c.lastSendError) {
        parts.push("send failed");
        tone = "blocked";
      }
      return { text: parts.join(" · "), tone };
    }
    default:
      return { text: c.status, tone: "muted" };
  }
}
