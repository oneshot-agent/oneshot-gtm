import type { InboxReplyView } from "@oneshot-gtm/shared-types";

/**
 * Match-status filter for the /inbox replies list. `matched` is an object when
 * the sender maps to a known prospect/cadence and null otherwise (the "no match"
 * badge — newsletters, bounces, system mail). The filter lets the founder hide
 * that noise and focus on real prospect replies.
 */
export type ReplyMatchFilter = "all" | "matched" | "no-match";

export function matchesReplyFilter(reply: InboxReplyView, filter: ReplyMatchFilter): boolean {
  if (filter === "matched") return reply.matched != null;
  if (filter === "no-match") return reply.matched == null;
  return true;
}
