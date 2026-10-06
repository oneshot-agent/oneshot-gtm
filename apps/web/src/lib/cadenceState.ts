/**
 * The /cadences row's second line (issue #602): where this person is in the
 * sequence, in one mono label: "step 2 of 4 · sent 3d ago · next in 1d",
 * "replied on linkedin · 2d ago", "stopped · not a fit · 5d ago". Pure: the
 * clock is injected so the cases are testable, and the label uppercases in
 * the row, so the text here is plain case.
 */
import type {
  CadenceHeldElsewhere,
  CadenceStopReason,
  CadenceView,
} from "@oneshot-gtm/shared-types";
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
  // A skipped letter is history, not a send: "sent 3d ago" stays the last email.
  const lastSent = c.priorSteps.findLast((s) => s.status !== "skipped")?.sentAt ?? null;

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
      // The runner skips a held step whatever is clicked, so say so instead
      // of leaving it reading as overdue.
      if (c.heldElsewhere && new Date(c.heldElsewhere.until).getTime() > nowMs) {
        parts.push(heldLabel(c.heldElsewhere, nowMs));
        tone = "muted";
      }
      return { text: parts.join(" · "), tone };
    }
    default:
      return { text: c.status, tone: "muted" };
  }
}

/** "held · emailed from sdk 1d ago · sends after Oct 12". */
export function heldLabel(h: CadenceHeldElsewhere, nowMs: number): string {
  return `held · emailed from ${h.workspace} ${timeAgo(h.sentAt, nowMs)} · sends after ${shortDate(h.until)}`;
}

/** True while another workspace's touch holds this cadence's next send. */
export function isHeldElsewhere(c: CadenceView, nowMs: number = Date.now()): boolean {
  return c.heldElsewhere != null && new Date(c.heldElsewhere.until).getTime() > nowMs;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The cadences waiting on a letter (issue #611): active, next step goes by
 * post, nothing in flight. The bulk skip takes all waiting letters directly;
 * email batches exclude these rows even when selected for batch stopping.
 */
export function mailWaitingRows(list: ReadonlyArray<CadenceView>): CadenceView[] {
  return list.filter(
    (c) => c.status === "active" && c.nextStepChannel === "direct_mail" && !c.isSending,
  );
}
