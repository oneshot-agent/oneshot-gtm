import { demoMode, getLinkedInInboxStore, getReplyReviewStore } from "@oneshot-gtm/core";
import { callLinkedIn } from "./linkedin-client.ts";

/** Revoke the shared connection while keeping imported conversations and assignments. */
export async function removeLinkedInAccount(accountKey: string) {
  if (demoMode()) throw new Error("The demo is read-only.");
  const store = getLinkedInInboxStore();
  const review = getReplyReviewStore();
  const account = store.account(accountKey);
  if (!account) throw new Error("LinkedIn account not found.");
  if (account.removedAt) return { ok: true };
  const leases: Array<[string, string]> = [];
  try {
    for (const key of [`backfill:${accountKey}`, `capture:${accountKey}`]) {
      const token = review.claim(key, 120_000);
      if (!token)
        throw new Error(
          "History is currently syncing. Try removing the account again when this sync finishes.",
        );
      leases.push([key, token]);
    }
    const result = await callLinkedIn<{ status: string; upstream_deleted: boolean }>(
      account.workspace,
      { kind: "revoke", accountId: account.account.id },
    );
    if (result.status !== "revoked")
      throw new Error("The provider did not confirm account removal. Try again.");
    store.saveAccount({ ...account, removedAt: new Date().toISOString() });
    return { ok: true, upstreamDeleted: result.upstream_deleted };
  } finally {
    for (const [key, token] of leases) review.release(key, token);
  }
}

/** A fresh hosted connection for the same member, adopted under the existing local keys. */
export async function forceReconnectLinkedInAccount(accountKey: string) {
  if (demoMode()) throw new Error("The demo is read-only.");
  const store = getLinkedInInboxStore();
  const review = getReplyReviewStore();
  const account = store.account(accountKey);
  if (!account || account.removedAt) throw new Error("LinkedIn account not found.");
  if (!account.account.member_urn)
    throw new Error(
      "Cannot safely replace this connection without its LinkedIn member identity. Use the normal Reconnect option.",
    );
  const leases: Array<[string, string]> = [];
  try {
    for (const key of [`backfill:${accountKey}`, `capture:${accountKey}`]) {
      const token = review.claim(key, 120_000);
      if (!token)
        throw new Error(
          "History is currently syncing. Try force reconnect again when this sync finishes.",
        );
      leases.push([key, token]);
    }
    const result = await callLinkedIn<{ status: string; upstream_deleted: boolean }>(
      account.workspace,
      { kind: "revoke", accountId: account.account.id },
    );
    if (result.status !== "revoked")
      throw new Error("The provider did not confirm disconnection. Try again.");
    store.saveAccount({
      ...account,
      account: { ...account.account, status: "revoked", allowed_actions: [] },
    });
    const progress = {
      stage: "revoked",
      oldAccountKey: accountKey,
      oldAccountId: account.account.id,
      member: account.account.member_urn,
      pauseBackfill: true,
    };
    store.saveProgress(`replacement:${accountKey}`, progress);
    if (!result.upstream_deleted)
      throw new Error(
        "Access was revoked, but provider disconnection is still pending. Your messages are saved. Try force reconnect again shortly.",
      );
    try {
      const intent = await callLinkedIn<{ intent_id: string; url: string; expires_at: string }>(
        account.workspace,
        { kind: "connect" },
      );
      store.saveProgress(`replacement:${accountKey}`, {
        ...progress,
        stage: "awaiting_login",
        intentId: intent.intent_id,
        expiresAt: intent.expires_at,
      });
      return intent;
    } catch {
      throw new Error(
        "The old connection was disconnected, but a new login could not be opened. Your messages are saved. Try force reconnect again.",
      );
    }
  } finally {
    for (const [key, token] of leases) review.release(key, token);
  }
}
