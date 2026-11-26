import {
  classifyReply,
  demoMode,
  demoFixture,
  currentWorkspaceName,
  getLedger,
  getLinkedInInboxStore,
  getReplyReviewStore,
  isHumanLinkedInReply,
  loadConfig,
  linkedInMatches,
  replyAvoidTermsOf,
  replyContextVersion,
  productBriefText,
} from "@oneshot-gtm/core";
import type { LinkedInViewer } from "@oneshot-gtm/core";
import type {
  InboxResult,
  ReplyMessage,
  RepliesResult,
  ReplyThread,
} from "@oneshot-gtm/shared-types";
import { backfillStatus } from "../linkedin-backfill.ts";
import { linkedInViewer } from "../members.ts";
import { listInboxRoute } from "./inbox.ts";

import { emailThreads } from "@oneshot-gtm/shared-types";

/**
 * The LinkedIn conversations this workspace lists. With a viewer, only those
 * on accounts that member connected, matched to a prospect or not: every
 * route passes one.
 */
export function linkedInThreads(viewer?: LinkedInViewer): ReplyThread[] {
  const store = getLinkedInInboxStore();
  const workspace = currentWorkspaceName();
  const matches = linkedInMatches();
  return store
    .threads(undefined, viewer)
    .filter((t) => !t.owner || t.owner.workspace === workspace)
    .flatMap((t) => {
      const a = store.account(t.accountKey, viewer);
      if (!a) return [];
      const c = t.conversation;
      const rawMessages = store.messages(a.key, c.id, viewer);
      const sender = rawMessages.findLast((m) => m.direction === "inbound" && !m.deleted);
      const profile = sender ? store.senderProfile(a.key, c, sender) : null;
      const found = profile ? matches.filter((m) => m.profile === profile) : [];
      const matchStatus = t.owner
        ? ("matched" as const)
        : !profile
          ? ("missing_identity" as const)
          : found.length
            ? ("ambiguous" as const)
            : ("no_prospect" as const);
      const history: ReplyMessage[] = rawMessages.map((m) => ({
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
      // The label of the newest human reply only, as email reads its latest
      // reply. An older label never stands in for an unlabelled newer reply:
      // reply options take it as the intent of the message they answer.
      // Only human inbound messages are ever labelled.
      const labels = store.conversationIntents(a.key, c.id);
      const newestHuman = rawMessages.findLast(isHumanLinkedInReply);
      const label = (newestHuman && labels.get(newestHuman.id)) ?? null;
      const peers = c.attendees.filter((p) => !p.is_self);
      const peer = peers[0];
      const currentConnection = !a.previousAccountIds?.length || t.sourceAccountId === a.account.id;
      const connectionAvailable =
        !a.removedAt &&
        a.account.status === "connected" &&
        a.sync?.sync_state !== "reconnect_required" &&
        a.account.allowed_actions.includes("reply");
      const canSend = connectionAvailable && currentConnection && !c.read_only;
      // LinkedIn marks a group chat `type: 1` (even when only one other member
      // is left). Some direct chats sync with no type at all; with exactly one
      // other attendee those are one-to-one too, not groups.
      const oneToOne = c.attendees_synced && (c.type === 0 || c.type == null) && peers.length === 1;
      const canGenerate =
        !a.removedAt && currentConnection && oneToOne && !!latest.body.trim() && latest.human;
      const linkedinConnectionState = !connectionAvailable
        ? ("unavailable" as const)
        : !currentConnection
          ? ("restoring" as const)
          : ("connected" as const);
      const reason = !connectionAvailable
        ? a.removedAt
          ? "This connection was removed. Imported messages remain saved."
          : "Connect an account with reply permission to send."
        : !currentConnection
          ? "LinkedIn is connected. This saved conversation is waiting to be restored through the new connection before you can send. Check the history import under Connections."
          : c.read_only
            ? "This conversation is read-only on LinkedIn."
            : !oneToOne
              ? c.attendees_synced
                ? "Review this group conversation and write a reply manually."
                : "Participant details are incomplete. Review the conversation and write a reply manually."
              : !latest.body.trim()
                ? "This message has no text. Review it on LinkedIn before replying."
                : undefined;
      return [
        {
          key: t.key,
          channel: "linkedin" as const,
          name: peer?.name ?? sender?.sender_name ?? c.name ?? "LinkedIn conversation",
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
          linkedinConnectionState,
          canGenerate,
          intent: label?.intent ?? null,
          intentReview: label?.review ?? false,
          // The LinkedIn account is shared by every workspace: an unassigned
          // conversation drafts as the workspace it is opened in, with no
          // prospect research behind it. Say so wherever its drafts show.
          ...(t.owner || !canGenerate
            ? {}
            : {
                draftingWarning: `Not assigned to a prospect. Drafts use the ${workspace} workspace's product, brief and voice, with no prospect research. If this person is a prospect, assign them under "Contact details & assignment".`,
              }),
          unavailableReason: reason,
          contextVersion: "",
          drafts: null,
          send: null,
          accountKey: a.key,
          conversationId: c.id,
          profileUrl: profile ? `https://${profile}` : peer?.profile_url,
          matchStatus,
        },
      ];
    });
}

/**
 * What a thread's drafts were written against, for the workspace handling the
 * request. Unassigned LinkedIn conversations are listed by every workspace
 * and saved to one shared store, so the stored value is whichever workspace
 * listed last: always recompute it here instead of trusting the store.
 */
export function threadContextVersion(
  t: ReplyThread,
  workspace: string = currentWorkspaceName(),
): string {
  const cfg = loadConfig();
  const prospect =
    t.prospectId != null && t.workspace === workspace
      ? getLedger().getProspectById(t.prospectId)
      : null;
  return replyContextVersion({
    messages: t.messages.map((m) => [m.id, m.direction, m.body, m.deleted]),
    // Unassigned LinkedIn drafts as the viewing workspace: a draft made in
    // another workspace is for another product, so it must read as stale here.
    workspace: t.workspace ?? (t.channel === "linkedin" ? workspace : null),
    prospect: t.prospectId,
    // The composed brief: approving a code answer makes cached drafts stale.
    brief: productBriefText(cfg),
    voice: cfg.founderVoice,
    dossier: prospect?.dossier_json,
    angle: prospect?.angle_json,
    // Approved guidance moved: a cached generation no longer reflects it (#813).
    learning: guidanceVersionOrZero(),
    // The options read the classified intent: a relabel makes them stale.
    intent: t.intent ?? null,
    avoidTerms: replyAvoidTermsOf(cfg),
    // 2: options see the offer and intent and can take the scope move.
    prompt: 2,
  });
}

/** The ledger's guidance version; 0 when a ledger double has no learning store. */
function guidanceVersionOrZero(): number {
  try {
    return getLedger().learning.guidanceVersion();
  } catch {
    return 0;
  }
}

export async function collectReplies(req: Request): Promise<RepliesResult> {
  const inbox = (await (await listInboxRoute(req)).json()) as InboxResult;
  const workspace = currentWorkspaceName();
  if (demoMode()) {
    const linkedin =
      demoFixture<Pick<RepliesResult, "threads" | "accounts">>("linkedin-replies.json");
    return {
      threads: [...emailThreads(inbox, workspace), ...(linkedin?.threads ?? [])].toSorted((a, b) =>
        b.lastActivityAt.localeCompare(a.lastActivityAt),
      ),
      accounts: linkedin?.accounts ?? [],
      mailboxes: inbox.mailboxes ?? [],
      workspace,
      hasMore: inbox.hasMore,
      error: inbox.error,
    };
  }
  const review = getReplyReviewStore();
  const viewer = linkedInViewer(req);
  const incoming = [
    ...emailThreads(inbox, workspace, (email) => getLedger().getProspectByEmail(email)?.id ?? null),
    ...linkedInThreads(viewer),
  ];
  for (const t of incoming) {
    t.contextVersion = threadContextVersion(t, workspace);
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
  for (const t of threads) {
    // Resolve saved conversations against this workspace only, including records
    // outside the live provider window and fields cleared since the last sync.
    const prospect =
      t.prospectId != null && t.workspace === workspace
        ? getLedger().getProspectById(t.prospectId)
        : null;
    t.matchedProspect = prospect
      ? { id: prospect.id, name: prospect.name ?? null, email: prospect.email ?? null }
      : null;
    if (t.channel === "email" && prospect) {
      t.name = prospect.name || t.name;
      t.company = prospect.company;
      t.profileUrl = prospect.linkedin_url ?? null;
    } else {
      t.profileUrl = t.profileUrl || prospect?.linkedin_url || null;
    }
  }
  // Every member sees which accounts are connected and whether they work:
  // a workspace may send from any of them. Import detail and provider errors
  // go to the member who connected the account, like its messages.
  const store = getLinkedInInboxStore();
  const accounts = store
    .accounts()
    .filter((a) => !a.removedAt)
    .map((a) => {
      const mine = store.visibleTo(a.key, viewer);
      return {
        key: a.key,
        id: a.account.id,
        name: a.account.display_name ?? "LinkedIn",
        workspace: a.workspace,
        status: a.account.status,
        syncState: a.sync?.sync_state ?? "never_synced",
        complete:
          !!a.sync?.coverage.complete &&
          ["active", "archived", "messages"].every(
            (r) => store.progress<{ complete?: boolean }>(`${a.key}:${r}`)?.complete,
          ),
        lastCheckedAt: a.checkedAt,
        error: mine ? a.error : null,
        canReply: a.account.allowed_actions.includes("reply"),
        canResolve: a.account.allowed_actions.includes("view_profile"),
        canInvite: a.account.allowed_actions.includes("invite"),
        permissionUpgradeError: mine ? a.permissionUpgradeError : undefined,
        backfill: mine ? backfillStatus(a.key) : null,
        ownerMember: a.ownerMember || null,
        mine,
      };
    });
  return {
    threads: threads.toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    accounts,
    mailboxes: inbox.mailboxes ?? [],
    workspace,
    hasMore: inbox.hasMore,
    error: inbox.error,
  };
}
