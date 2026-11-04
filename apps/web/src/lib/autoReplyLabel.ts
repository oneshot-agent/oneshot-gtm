import type { InboxReplyView } from "@oneshot-gtm/shared-types";

function shortDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * The /inbox badge for a non-human inbound: what the automatic reply said
 * when it has been read ("left company", "away until Nov 9"), else what the
 * deliverability classifier called it.
 */
export function autoReplyLabel(
  reply: Pick<InboxReplyView, "kind" | "autoReason" | "returnDate">,
): string {
  if (reply.kind === "unsubscribe") return "opted out";
  if (reply.autoReason === "left_company") return "left company";
  if (reply.autoReason === "out_of_office") {
    return reply.returnDate ? `away until ${shortDay(reply.returnDate)}` : "away · no return date";
  }
  return reply.kind === "auto_permanent" ? "mailbox unavailable" : "automatic reply";
}
