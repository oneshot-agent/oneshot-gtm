import {
  classifyReply,
  demoMode,
  currentWorkspaceName,
  getLedger,
  getLinkedInInboxStore,
  getReplyReviewStore,
  loadConfig,
  replyContextVersion,
} from "@oneshot-gtm/core";
import type {
  InboxResult,
  ReplyMessage,
  RepliesResult,
  ReplyThread,
} from "@oneshot-gtm/shared-types";
import { listInboxRoute } from "./inbox.ts";

import { emailThreads } from "@oneshot-gtm/shared-types";

export function linkedInThreads(): ReplyThread[] {
  const store = getLinkedInInboxStore();
  const workspace = currentWorkspaceName();
  return store
    .threads()
    .filter((t) => !t.owner || t.owner.workspace === workspace)
    .flatMap((t) => {
      const a = store.account(t.accountKey);
      if (!a) return [];
      const c = t.conversation;
      const history: ReplyMessage[] = store.messages(a.key, c.id).map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.text ?? "",
        at: m.sent_at,
        human:
          m.direction === "outbound" ||
          classifyReply({ subject: "", body: m.text ?? "" }) === "human",
        attachment: m.attachments.length > 0,
        deleted: m.deleted,
      }));
      const latest = history.findLast((m) => m.direction === "inbound" && !m.deleted);
      if (!latest) return [];
      const peers = c.attendees.filter((p) => !p.is_self);
      const peer = peers[0];
      const canSend =
        a.account.status === "connected" &&
        a.sync?.sync_state !== "reconnect_required" &&
        a.account.allowed_actions.includes("reply") &&
        !c.read_only;
      const oneToOne = c.attendees_synced && peers.length === 1;
      const reason = !canSend
        ? "Connect an account with reply permission and a writable conversation."
        : !t.owner
          ? "Assign a workspace and prospect to generate replies."
          : !oneToOne
            ? "Review this group conversation and write a reply manually."
            : !latest.body.trim()
              ? "This message has no text. Review it on LinkedIn before replying."
              : undefined;
      return [
        {
          key: t.key,
          channel: "linkedin" as const,
          name: peer?.name ?? c.name ?? "LinkedIn conversation",
          company: peer?.occupation ?? null,
          subject: c.subject ?? "LinkedIn conversation",
          address: peer?.profile_url ?? "",
          workspace: t.owner?.workspace ?? null,
          prospectId: t.owner?.prospectId ?? null,
          messages: history,
          lastActivityAt: history.at(-1)?.at ?? c.last_message_at,
          archivedAt: null,
          snoozedUntil: null,
          needsReply: history.findLast((m) => m.human && !m.deleted)?.direction === "inbound",
          canSend,
          canGenerate: !!t.owner && oneToOne && !!latest.body.trim() && latest.human,
          unavailableReason: reason,
          contextVersion: "",
          drafts: null,
          send: null,
          accountKey: a.key,
          conversationId: c.id,
          profileUrl: peer?.profile_url,
        },
      ];
    });
}

export async function collectReplies(req: Request): Promise<RepliesResult> {
  const inbox = (await (await listInboxRoute(req)).json()) as InboxResult;
  const workspace = currentWorkspaceName();
  if (demoMode())
    return {
      threads: emailThreads(inbox, workspace),
      accounts: [],
      mailboxes: inbox.mailboxes ?? [],
      workspace,
      hasMore: inbox.hasMore,
      error: inbox.error,
    };
  const review = getReplyReviewStore();
  const cfg = loadConfig();
  const incoming = [
    ...emailThreads(inbox, workspace, (email) => getLedger().getProspectByEmail(email)?.id ?? null),
    ...linkedInThreads(),
  ];
  for (const t of incoming) {
    const prospect = t.prospectId == null ? null : getLedger().getProspectById(t.prospectId);
    t.contextVersion = replyContextVersion({
      messages: t.messages.map((m) => [m.id, m.direction, m.body, m.deleted]),
      workspace: t.workspace,
      prospect: t.prospectId,
      brief: cfg.productBrief,
      voice: cfg.founderVoice,
      dossier: prospect?.dossier_json,
      angle: prospect?.angle_json,
      prompt: 1,
    });
    review.upsert(t.channel === "email" ? `email:${workspace}` : "linkedin", t);
  }
  // Retain older unmatched email threads even after they leave the live provider window.
  const matchedInboundIds = new Set(
    incoming
      .filter((t) => t.channel === "email" && t.prospectId != null)
      .flatMap((t) => t.messages.filter((m) => m.direction === "inbound").map((m) => m.id)),
  );
  const retainedEmail = review
    .list(`email:${workspace}`)
    .filter(
      (t) =>
        t.prospectId != null ||
        !t.messages.some((m) => m.direction === "inbound" && matchedInboundIds.has(m.id)),
    );
  const threads = [
    ...retainedEmail,
    ...incoming.filter((t) => t.channel === "linkedin").map((t) => review.get(t.key)!),
  ];
  const accounts = getLinkedInInboxStore()
    .accounts()
    .map((a) => ({
      key: a.key,
      id: a.account.id,
      name: a.account.display_name ?? "LinkedIn",
      workspace: a.workspace,
      status: a.account.status,
      syncState: a.sync?.sync_state ?? "never_synced",
      complete:
        !!a.sync?.coverage.complete &&
        ["active", "archived", "messages"].every(
          (r) =>
            getLinkedInInboxStore().progress<{ complete?: boolean }>(`${a.key}:${r}`)?.complete,
        ),
      lastCheckedAt: a.checkedAt,
      error: a.error,
      canReply: a.account.allowed_actions.includes("reply"),
    }));
  return {
    threads: threads.toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    accounts,
    mailboxes: inbox.mailboxes ?? [],
    workspace,
    hasMore: inbox.hasMore,
    error: inbox.error,
  };
}
