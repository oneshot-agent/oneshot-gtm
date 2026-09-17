import type { ReplyThread } from "@oneshot-gtm/shared-types";
export type ReplyView = "inbox" | "snoozed" | "archived";
export function replyInView(
  t: Pick<ReplyThread, "archivedAt" | "snoozedUntil">,
  view: ReplyView,
  now = Date.now(),
): boolean {
  const snoozed = !!t.snoozedUntil && Date.parse(t.snoozedUntil) > now;
  return view === "archived"
    ? !!t.archivedAt
    : !t.archivedAt && (view === "snoozed" ? snoozed : !snoozed);
}
export function replyNeedsAttention(t: ReplyThread): boolean {
  return (
    replyInView(t, "inbox") &&
    (t.needsReply || !!t.drafts?.flags[t.drafts.selected]?.includes("commits-terms"))
  );
}
