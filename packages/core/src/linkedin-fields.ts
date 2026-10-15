import type {
  LinkedInAttendee as SdkLinkedInAttendee,
  LinkedInConversation as SdkLinkedInConversation,
  LinkedInConversationsPage as SdkLinkedInConversationsPage,
  LinkedInMessage as SdkLinkedInMessage,
  LinkedInMessagesPage as SdkLinkedInMessagesPage,
  LinkedInSyncStatus as SdkLinkedInSyncStatus,
} from "@oneshot-agent/sdk";

/**
 * OneShot renamed the LinkedIn identity fields on 2026-10-15 (`provider_*` to
 * `external_*`, the coverage `provider_history*` to `history_sync_*`). The
 * inbox store keeps every message and conversation as the JSON it arrived
 * as, indexes the old names, and matches replies on them, so new results get
 * the old names added beside the new ones and old rows keep working.
 */
const LEGACY_NAMES: Record<string, string> = {
  external_id: "provider_id",
  external_message_id: "provider_message_id",
  sender_external_id: "sender_provider_id",
  external_chat_id: "provider_chat_id",
  external_invitation_id: "provider_invitation_id",
  history_sync_status: "provider_history",
  history_sync_completed_at: "provider_history_completed_at",
};

/** Copy each renamed field to its old name, at any depth, where the old one is missing. */
export function withLegacyLinkedInNames<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withLegacyLinkedInNames) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = withLegacyLinkedInNames(v);
  for (const [current, legacy] of Object.entries(LEGACY_NAMES))
    if (current in out && !(legacy in out)) out[legacy] = out[current];
  return out as T;
}

export type LinkedInAttendee = Omit<SdkLinkedInAttendee, "external_id"> & {
  provider_id: string | null;
};
export type LinkedInMessage = Omit<
  SdkLinkedInMessage,
  "external_message_id" | "sender_external_id"
> & {
  provider_message_id: string;
  sender_provider_id: string | null;
};
export type LinkedInConversation = Omit<
  SdkLinkedInConversation,
  "attendees" | "external_chat_id"
> & {
  provider_chat_id: string;
  attendees: LinkedInAttendee[];
};
export type LinkedInConversationsPage = Omit<SdkLinkedInConversationsPage, "conversations"> & {
  conversations: LinkedInConversation[];
};
export type LinkedInMessagesPage = Omit<SdkLinkedInMessagesPage, "messages"> & {
  messages: LinkedInMessage[];
};
export type LinkedInSyncStatus = Omit<SdkLinkedInSyncStatus, "coverage"> & {
  coverage: Omit<
    SdkLinkedInSyncStatus["coverage"],
    "history_sync_status" | "history_sync_completed_at"
  > & {
    provider_history: SdkLinkedInSyncStatus["coverage"]["history_sync_status"];
    provider_history_completed_at: string | null;
  };
};
