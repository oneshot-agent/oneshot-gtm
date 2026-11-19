import type { ReplyThread } from "@oneshot-gtm/shared-types";
import { IntentBadge } from "./IntentBadge.tsx";

/** A conversation row's reply label, either channel; nothing until one is labelled. */
export function ReplyRowLabel({
  thread: t,
}: {
  thread: Pick<ReplyThread, "intent" | "intentReview">;
}) {
  if (!t.intent) return null;
  return (
    <span className="replies-row-label">
      <IntentBadge intent={t.intent} review={t.intentReview} />
    </span>
  );
}
