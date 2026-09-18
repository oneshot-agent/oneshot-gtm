import type { InboxReplyView, MailboxHealthView } from "./index.ts";

export const REPLY_VARIANTS = ["direct", "technical", "warm"] as const;
export type ReplyVariant = (typeof REPLY_VARIANTS)[number];
export type ReplyChannel = "email" | "linkedin";
export interface ReplyMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  at: string;
  human: boolean;
  attachment?: boolean;
  deleted?: boolean;
}
export interface ReplyDraftSet {
  learningVersion?: number;
  /** Server-issued improvement IDs explicitly adopted by the reviewer. */
  improvementIds?: Partial<Record<ReplyVariant, string[]>>;
  id: string;
  revision: number;
  contextVersion: string;
  read: string;
  originals: Record<ReplyVariant, string>;
  edits: Record<ReplyVariant, string>;
  moves: Partial<Record<ReplyVariant, string>>;
  flags: Record<ReplyVariant, string[]>;
  setFlags: string[];
  selected: ReplyVariant;
  steer: string;
  generated: boolean;
}
export interface ReplySendState {
  id: string;
  status: "pending" | "uncertain" | "sent" | "failed";
  body: string;
  variant: ReplyVariant;
  generationId: string;
  requestId?: string;
  error?: string;
  sentAt?: string;
}
export interface ReplyThread {
  key: string;
  channel: ReplyChannel;
  name: string;
  company: string | null;
  subject: string;
  address: string;
  workspace: string | null;
  prospectId: number | null;
  messages: ReplyMessage[];
  lastActivityAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
  needsReply: boolean;
  canSend: boolean;
  canGenerate: boolean;
  unavailableReason?: string;
  contextVersion: string;
  drafts: ReplyDraftSet | null;
  send: ReplySendState | null;
  email?: InboxReplyView;
  mailboxThreadKey?: string;
  historyComplete?: boolean;
  accountKey?: string;
  conversationId?: string;
  profileUrl?: string | null;
}
export interface LinkedInAccountView {
  key: string;
  id: string;
  name: string;
  workspace: string;
  status: string;
  syncState: string;
  complete: boolean;
  lastCheckedAt: string | null;
  error: string | null;
  canReply: boolean;
}
export interface RepliesResult {
  threads: ReplyThread[];
  accounts: LinkedInAccountView[];
  mailboxes: MailboxHealthView[];
  workspace: string;
  hasMore: boolean;
  error?: string;
}
export interface ReplyStateRequest {
  key: string;
  action: "archive" | "restore" | "snooze" | "unsnooze";
  observedReplyIds: string[];
}

export interface ReplyLearningEvidence {
  id: string;
  threadKey: string;
  name: string;
  body: string;
  original: string | null;
  feedback: string[];
  historical: boolean;
  at: string;
}
export interface ReplyPreference {
  id: string;
  instruction: string;
  source: "explicit" | "edits" | "style";
  enabled: boolean;
  evidence: ReplyLearningEvidence[];
}
export interface ReplyLearningStatus {
  enabled: boolean;
  version: number;
  pending: boolean;
  imported: boolean;
  lastRefreshedAt: string | null;
  error: string | null;
  preferences: ReplyPreference[];
}
export type ReplyLearningUpdate = { enabled: boolean } | { preferenceId: string; enabled: boolean };
