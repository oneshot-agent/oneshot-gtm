import { getAgent, buildAuditOpts } from "./oneshot.ts";
import { demoMode } from "./demo.ts";
import { getLedger } from "./ledger.ts";
import type { LinkedInConversationsOptions, LinkedInMessagesOptions } from "@oneshot-agent/sdk";

export type LinkedInOperation =
  | { kind: "accounts" }
  | { kind: "connect"; accountId?: string }
  | { kind: "connection"; intentId: string }
  | { kind: "status"; accountId: string }
  | { kind: "conversations"; options: LinkedInConversationsOptions }
  | { kind: "messages"; options: LinkedInMessagesOptions }
  | { kind: "sync"; accountId: string }
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
      return operation.accountId
        ? agent.reconnectLinkedInAccount(operation.accountId)
        : agent.linkedinConnect({ requestedActions: ["read", "reply"] });
    case "connection":
      return agent.getLinkedInConnection(operation.intentId);
    case "status":
      return agent.getLinkedInSync(operation.accountId);
    case "conversations":
      return agent.linkedinConversations(operation.options);
    case "messages":
      return agent.linkedinMessages(operation.options);
    case "sync": {
      const result = await agent.linkedinSync({
        accountId: operation.accountId,
        mode: "continue",
        maxPages: 10,
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
      const result = await agent.linkedinReply({
        accountId: operation.accountId,
        conversationId: operation.conversationId,
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
