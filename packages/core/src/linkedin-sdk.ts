import { getAgent, buildAuditOpts } from "./oneshot.ts";
import { demoMode } from "./demo.ts";
import { getLedger } from "./ledger.ts";
import type { LinkedInConversationsOptions, LinkedInMessagesOptions } from "@oneshot-agent/sdk";

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
  | { kind: "wait"; requestId: string };

/** All messaging calls go through the SDK. Read operations never trigger a paid history sync. */
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
      return operation.accountId && !operation.upgrade
        ? agent.reconnectLinkedInAccount(operation.accountId)
        : agent.linkedinConnect({ requestedActions: ["read", "reply", "view_profile"] });
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
    case "wait":
      return agent.waitForResult(operation.requestId, { timeout: 2 });
  }
}
function record(result: unknown, callType: string) {
  const r = result as Record<string, unknown>;
  getLedger().recordReceipt({
    playName: "inbox-reply",
    callType,
    signedReceipt: result,
    costUsd: typeof r.cost === "number" ? r.cost : undefined,
    oneshotRequestId: typeof r.request_id === "string" ? r.request_id : undefined,
    memo: `LinkedIn ${callType} from Replies`,
  });
}
