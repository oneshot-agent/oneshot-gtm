import {
  REPLY_INTENTS,
  replyIntentMeta,
  type ReplyIntent,
  type ReplyThread,
} from "@oneshot-gtm/shared-types";
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
export type ReplyTab = ReplyView | "needs-reply";
export function replyInTab(t: ReplyThread, tab: ReplyTab): boolean {
  return tab === "needs-reply" ? replyNeedsAttention(t) : replyInView(t, tab);
}
/**
 * The Replies page label filter: a group, or one reply label. "positive" is
 * the labels with positive polarity (the green badges), not
 * POSITIVE_REPLY_INTENTS, which also holds complaints and other labels that
 * wait for an answer.
 */
export type ReplyLabelFilter = "all" | "positive" | "unlabelled" | ReplyIntent;
export function replyHasLabel(t: Pick<ReplyThread, "intent">, filter: ReplyLabelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unlabelled") return !t.intent;
  if (filter === "positive") return replyIntentMeta(t.intent)?.polarity === "positive";
  return t.intent === filter;
}
/**
 * The label filter's options with a count each: All, Positive, every label in
 * table order, then Unlabelled. A label nobody has is left out unless it is
 * the selected one.
 */
export function replyLabelOptions(
  threads: Pick<ReplyThread, "intent">[],
  selected: ReplyLabelFilter,
): { value: ReplyLabelFilter; title: string; count: number }[] {
  const count = (filter: ReplyLabelFilter) =>
    threads.filter((t) => replyHasLabel(t, filter)).length;
  const labels = REPLY_INTENTS.map((i) => ({
    value: i.label,
    title: i.title,
    count: count(i.label),
  }));
  return [
    { value: "all", title: "All labels", count: threads.length },
    { value: "positive", title: "Positive", count: count("positive") },
    ...labels.filter((o) => o.count > 0 || o.value === selected),
    { value: "unlabelled", title: "Unlabelled", count: count("unlabelled") },
  ];
}
