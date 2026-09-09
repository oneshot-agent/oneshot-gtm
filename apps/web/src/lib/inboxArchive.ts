import type { ConversationView } from "@oneshot-gtm/shared-types";

type Attention = Pick<ConversationView, "archivedAt" | "awaitingReply" | "status">;
export function inboxNeedsAttention(conversation: Attention): boolean {
  return (
    !conversation.archivedAt &&
    (conversation.awaitingReply || conversation.status === "needs_decision")
  );
}
export function inboxConversations<T extends Pick<ConversationView, "archivedAt">>(
  conversations: T[],
  archived: boolean,
): T[] {
  return conversations.filter((c) => Boolean(c.archivedAt) === archived);
}
