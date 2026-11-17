import { getLinkedInInboxStore } from "@oneshot-gtm/core";
import type { LinkedInAccount } from "@oneshot-agent/sdk";
import { callLinkedIn } from "./linkedin-client.ts";

interface ConnectionIntent {
  intentId: string;
  wallet: string;
  workspace: string;
  complete?: boolean;
}

/** Persist the initiating workspace before the user can complete the hosted login. */
export async function connectLinkedIn(workspace: string) {
  const { wallet } = await callLinkedIn<{ wallet: string }>(workspace, { kind: "accounts" });
  const result = await callLinkedIn<{ intent_id: string; url: string }>(workspace, {
    kind: "connect",
  });
  if (!result.intent_id) throw new Error("LinkedIn returned no connection intent");
  getLinkedInInboxStore().saveProgress(`connect:${result.intent_id}`, {
    intentId: result.intent_id,
    wallet,
    workspace,
  } satisfies ConnectionIntent);
  return result;
}

/** Resolve ownership before discovery, including after the connecting tab/server closes. */
export async function adoptLinkedInConnections(): Promise<Set<string>> {
  const store = getLinkedInInboxStore();
  const unresolvedWallets = new Set<string>();
  const intents = store.db
    .query<{ data: string }, []>("SELECT data FROM progress WHERE key LIKE 'connect:%'")
    .all()
    .map((r) => JSON.parse(r.data) as ConnectionIntent);
  for (const intent of intents) {
    if (intent.complete) continue;
    try {
      const result = await callLinkedIn<{ status: string; account?: LinkedInAccount | null }>(
        intent.workspace,
        { kind: "connection", intentId: intent.intentId },
      );
      if (result.status === "completed" && result.account) {
        const account = result.account;
        store.db
          .transaction(() => {
            const old = store
              .accounts()
              .find((a) => a.wallet === intent.wallet && a.account.id === account.id);
            // An existing connection/replacement retains its stable local key and history.
            store.saveAccount({
              ...old,
              key: old?.key ?? `${intent.wallet}:${account.id}`,
              wallet: intent.wallet,
              workspace: intent.workspace,
              account,
              sync: old?.sync ?? null,
              checkedAt: old?.checkedAt ?? null,
              error: null,
            });
            store.saveProgress(`connect:${intent.intentId}`, { ...intent, complete: true });
          })
          .immediate();
      } else if (["failed", "expired", "cancelled"].includes(result.status)) {
        store.saveProgress(`connect:${intent.intentId}`, { ...intent, complete: true });
      } else {
        unresolvedWallets.add(intent.wallet);
      }
    } catch {
      // Keep the intent retryable. Unknown accounts cannot be assigned to a discovering workspace.
      unresolvedWallets.add(intent.wallet);
    }
  }
  return unresolvedWallets;
}
