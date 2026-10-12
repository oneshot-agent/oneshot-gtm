import { getAgent, buildAuditOpts } from "./oneshot.ts";
import { demoMode } from "./demo.ts";
import { getLedger } from "./ledger.ts";
import type {
  LinkedInConversationsOptions,
  LinkedInInvitationsOptions,
  LinkedInMessagesOptions,
} from "@oneshot-agent/sdk";

export type LinkedInOperation =
  | { kind: "accounts" }
  | { kind: "revoke"; accountId: string }
  | { kind: "connect"; accountId?: string; upgrade?: boolean }
  | { kind: "profile"; accountId: string; identifier: string; idempotencyKey: string }
  | { kind: "connection"; intentId: string }
  | { kind: "status"; accountId: string }
  | { kind: "conversations"; options: LinkedInConversationsOptions }
  | { kind: "messages"; options: LinkedInMessagesOptions }
  | { kind: "sync"; accountId: string; idempotencyKey?: string }
  | {
      kind: "reply";
      accountId: string;
      conversationId: string;
      text: string;
      idempotencyKey: string;
    }
  | {
      /** First message to a connection that has no conversation yet. */
      kind: "message";
      accountId: string;
      /** linkedin.com/in/<slug> URL, slug or provider id. */
      profile: string;
      text: string;
      idempotencyKey: string;
      /** The play the cadence belongs to, for the receipt. */
      playName: string;
    }
  | { kind: "invitation"; accountId: string; invitationId: string }
  | {
      kind: "invitations";
      accountId: string;
      status?: LinkedInInvitationsOptions["status"];
      /** ISO time: only invitations whose status changed after this. */
      changedSince?: string;
      limit?: number;
    }
  | { kind: "wait"; requestId: string }
  | { kind: "account"; accountId: string }
  | {
      kind: "invite";
      accountId: string;
      /** linkedin.com/in/<slug> URL or provider id. */
      profile: string;
      note?: string;
      idempotencyKey: string;
      /** The play the invite belongs to, for the receipt. */
      playName: string;
    }
  | {
      kind: "withdraw";
      accountId: string;
      /** OneShot's stable invitation id returned by the invite. */
      invitationId: string;
      idempotencyKey: string;
      playName: string;
    };

/**
 * Whether a withdraw result means our invite is no longer outstanding
 * because of us: withdrawn now, cancelled before it went out, or already
 * withdrawn. `not_pending` (accepted, or gone for another reason) is not.
 */
export function isWithdrawnStatus(status: string | null | undefined): boolean {
  return (
    status === "withdrawn" || status === "cancelled_before_send" || status === "already_withdrawn"
  );
}

/** All messaging calls go through the SDK. Read operations never trigger a paid history sync. */
/** Every action GTM uses on a LinkedIn account: what a connection, or a widened one, is asked for. */
const LINKEDIN_GRANT = ["read", "reply", "view_profile", "invite"] as const;

export async function linkedInSdk(operation: LinkedInOperation): Promise<unknown> {
  if (demoMode()) throw new Error("LinkedIn is unavailable in demo mode");
  const agent = await getAgent();
  const audit = buildAuditOpts(
    { playName: "inbox-reply", memo: `LinkedIn ${operation.kind} from Replies` },
    `linkedin.${operation.kind}`,
  );
  switch (operation.kind) {
    case "accounts":
      return {
        wallet: agent.address.toLowerCase(),
        ...(await agent.listLinkedInAccounts({ includeRevoked: true })),
      };
    case "connect":
      // A new connection asks for every action. An existing account is
      // reconnected, which keeps the account, its conversations and its sync
      // progress. With `upgrade` the reconnect asks for the full grant: that
      // is how OneShot adds an action to a connected account (a second connect
      // for the same member is refused as `duplicate_member`).
      if (!operation.accountId) {
        return agent.linkedinConnect({ requestedActions: [...LINKEDIN_GRANT] });
      }
      return agent.reconnectLinkedInAccount(
        operation.accountId,
        operation.upgrade ? { requestedActions: [...LINKEDIN_GRANT] } : {},
      );
    case "revoke":
      return agent.revokeLinkedInAccount(operation.accountId);
    case "connection":
      return agent.getLinkedInConnection(operation.intentId);
    case "status":
      return agent.getLinkedInSync(operation.accountId);
    case "conversations":
      return agent.linkedinConversations(operation.options);
    case "messages":
      return agent.linkedinMessages(operation.options);
    case "profile": {
      const result = await agent.tool("linkedin/profile-view", {
        account_id: operation.accountId,
        identifier: operation.identifier,
        notify: false,
        wait: false,
        idempotencyKey: operation.idempotencyKey,
        ...audit,
      });
      record(result, "linkedin.profile");
      return result;
    }
    case "sync": {
      // SDK 0.35.0's linkedinSync injects timeout into the request body,
      // which this endpoint rejects. Use the SDK transport without that field;
      // wait:false returns the job immediately, so no polling timeout is needed.
      const result = await agent.tool("linkedin/sync", {
        account_id: operation.accountId,
        mode: "continue",
        ...(operation.idempotencyKey ? { idempotencyKey: operation.idempotencyKey } : {}),
        max_pages: 10,
        wait: false,
        ...audit,
      });
      record(result, "linkedin.sync");
      return result;
    }
    case "reply": {
      const account = await agent.getLinkedInAccount(operation.accountId);
      if (account.status !== "connected" || !account.allowed_actions.includes("reply"))
        throw new Error("Reconnect this LinkedIn account with permission to reply");
      if (!operation.text.trim() || operation.text.length > 4000)
        throw new Error("LinkedIn replies must contain 1–4000 characters");
      // The SDK convenience method adds a timeout field rejected by the API.
      const result = await agent.tool("linkedin/reply", {
        account_id: operation.accountId,
        conversation_id: operation.conversationId,
        text: operation.text,
        idempotencyKey: operation.idempotencyKey,
        wait: false,
        ...audit,
      });
      record(result, "linkedin.reply");
      return result;
    }
    case "message": {
      const account = await agent.getLinkedInAccount(operation.accountId);
      if (account.status !== "connected" || !account.allowed_actions.includes("reply"))
        throw new Error("Reconnect this LinkedIn account with permission to reply");
      if (!operation.text.trim() || operation.text.length > 4000)
        throw new Error("LinkedIn messages must contain 1–4000 characters");
      const result = await agent.linkedinMessage({
        accountId: operation.accountId,
        profile: operation.profile,
        text: operation.text,
        idempotencyKey: operation.idempotencyKey,
        ...buildAuditOpts({ playName: operation.playName }, "linkedin.message"),
      });
      record(
        result,
        "linkedin.message",
        operation.playName,
        `${operation.playName} LinkedIn first message`,
      );
      return result;
    }
    case "invitation":
      return agent.linkedinInvitation({
        accountId: operation.accountId,
        invitationId: operation.invitationId,
      });
    case "invitations":
      return agent.linkedinInvitations({
        accountId: operation.accountId,
        ...(operation.status ? { status: operation.status } : {}),
        ...(operation.changedSince ? { changedSince: operation.changedSince } : {}),
        ...(operation.limit ? { limit: operation.limit } : {}),
      });
    case "wait":
      return agent.waitForResult(operation.requestId, { timeout: 2 });
    case "account":
      return agent.getLinkedInAccount(operation.accountId);
    case "invite": {
      const account = await agent.getLinkedInAccount(operation.accountId);
      if (account.status !== "connected" || !account.allowed_actions.includes("invite"))
        throw new Error("Reconnect this LinkedIn account with permission to send invitations");
      const result = await agent.linkedinInvite({
        accountId: operation.accountId,
        profile: operation.profile,
        ...(operation.note ? { note: operation.note } : {}),
        idempotencyKey: operation.idempotencyKey,
        ...buildAuditOpts({ playName: operation.playName }, "linkedin.invite"),
      });
      record(
        result,
        "linkedin.invite",
        operation.playName,
        `${operation.playName} LinkedIn invite`,
      );
      return result;
    }
    case "withdraw": {
      const result = await agent.linkedinWithdrawInvitation({
        accountId: operation.accountId,
        invitationId: operation.invitationId,
        idempotencyKey: operation.idempotencyKey,
        ...buildAuditOpts({ playName: operation.playName }, "linkedin.withdraw"),
      });
      record(
        result,
        "linkedin.withdraw",
        operation.playName,
        `${operation.playName} LinkedIn invite withdrawal`,
      );
      return result;
    }
  }
}
function record(
  result: unknown,
  callType: string,
  playName = "inbox-reply",
  memo = `LinkedIn ${callType} from Replies`,
) {
  const r = result as Record<string, unknown>;
  getLedger().recordReceipt({
    playName,
    callType,
    signedReceipt: result,
    costUsd: typeof r.cost === "number" ? r.cost : undefined,
    oneshotRequestId:
      typeof r.request_id === "string"
        ? r.request_id
        : typeof r.action_request_id === "string"
          ? r.action_request_id
          : undefined,
    memo,
  });
}
