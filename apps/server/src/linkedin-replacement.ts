import {
  getLinkedInInboxStore,
  getReplyReviewStore,
  LinkedInReplacementOwnerMismatchError,
  linkedInMatches,
} from "@oneshot-gtm/core";
import type { LinkedInAccount } from "@oneshot-agent/sdk";
import { callLinkedIn } from "./linkedin-client.ts";

interface Replacement {
  stage: string;
  pauseBackfill?: boolean;
  oldAccountKey: string;
  oldAccountId: string;
  member: string | null;
  intentId?: string;
  expiresAt?: string;
  newAccountId?: string;
  error?: string;
}

/** Who owns a record, for a log line that names no member. */
const ownerLabel = (member: string | null) => (member ? "a member" : "no member");

/** A replacement login that has been opened and has not been adopted or given up yet. */
function awaitingLogin(accountKey: string): Replacement | null {
  const replacement = getLinkedInInboxStore().progress<Replacement>(`replacement:${accountKey}`);
  return replacement?.stage === "awaiting_login" && replacement.intentId ? replacement : null;
}

/**
 * Wallets where a replacement login is still open. An account that appears on
 * one may be what that login connected, and it belongs to the member who
 * started it, so discovery leaves it to the adoption below instead of
 * recording it with no member. Re-read after discovery's await, like
 * `pendingLinkedInConnectionWallets`.
 */
export function pendingLinkedInReplacementWallets(): Set<string> {
  return new Set(
    getLinkedInInboxStore()
      .accounts()
      .filter((a) => awaitingLogin(a.key))
      .map((a) => a.wallet),
  );
}

/** Only consumes an explicitly authorized, persisted replacement intent. Never revokes accounts. */
export async function adoptPendingLinkedInReplacements() {
  const store = getLinkedInInboxStore();
  const review = getReplyReviewStore();
  for (const a of store.accounts()) {
    const progressKey = `replacement:${a.key}`;
    const replacement = awaitingLogin(a.key);
    if (!replacement?.intentId) continue;
    // A login that cannot be checked right now (a worker timeout, say) stays open for the
    // next pass, like a connect intent. It does not stop the accounts after it.
    const result = await callLinkedIn<{
      status: string;
      failure_reason?: string;
      account?: LinkedInAccount | null;
    }>(a.workspace, { kind: "connection", intentId: replacement.intentId }).catch(() => null);
    if (!result || ["pending", "verifying"].includes(result.status)) continue;
    // A force reconnect during the poll may have stored a newer intent for this account.
    // Progress is written only while the stored record is still the intent polled here.
    const current = () =>
      store.progress<Replacement>(progressKey)?.intentId === replacement.intentId;
    const saveIfCurrent = (data: Replacement) =>
      store.db
        .transaction(() => {
          if (current()) store.saveProgress(progressKey, data);
        })
        .immediate();
    if (result.status !== "completed" || !result.account) {
      saveIfCurrent({
        ...replacement,
        stage: "failed",
        error: result.failure_reason ?? result.status,
      });
      continue;
    }
    const connected = result.account;
    const newKey = `${a.wallet}:${connected.id}`;
    // The login was opened from this account, so what it connected belongs to the
    // same member from here on, merged yet or not. Recorded before the replacement
    // stops being open, so discovery never finds the connection with no member.
    const keepForMember = () => {
      if (store.accounts().some((x) => x.wallet === a.wallet && x.account.id === connected.id))
        return;
      store.saveAccount({
        key: newKey,
        wallet: a.wallet,
        workspace: a.workspace,
        ownerMember: a.ownerMember || undefined,
        account: connected,
        sync: null,
        checkedAt: null,
        error: null,
      });
    };
    if (!current()) {
      // Superseded: the newer intent's record stays as it is, and this login's connection
      // is never merged into the account it reconnects. It stays the member's own account.
      keepForMember();
      continue;
    }
    if (a.removedAt) {
      // Nothing to merge into: the new connection stays an account of its own.
      keepForMember();
      saveIfCurrent({
        ...replacement,
        stage: "failed",
        error: "This LinkedIn connection has been removed.",
      });
      continue;
    }
    const claims: Array<[string, string]> = [];
    try {
      for (const key of [
        ...new Set([
          `capture:${a.key}`,
          `capture:${newKey}`,
          `backfill:${a.key}`,
          `backfill:${newKey}`,
        ]),
      ].toSorted()) {
        const token = review.claim(key, 120_000);
        if (!token) break;
        claims.push([key, token]);
      }
      const required = new Set([
        `capture:${a.key}`,
        `capture:${newKey}`,
        `backfill:${a.key}`,
        `backfill:${newKey}`,
      ]).size;
      if (claims.length !== required || store.account(a.key)?.removedAt) {
        // Another server is still capturing, or the account was removed meanwhile. The
        // new connection is captured under the member until the next pass settles it.
        keepForMember();
        continue;
      }
      // An import of the new connection has asked the provider for something that is not
      // back yet, and a merge would drop the request. That ends, so the login stays open
      // and a later pass merges. An import that cannot go on (its account was removed)
      // is refused by the merge below instead.
      if (
        store.progress<{ pending?: unknown }>(`backfill:${newKey}`)?.pending &&
        !store.account(newKey)?.removedAt
      ) {
        keepForMember();
        saveIfCurrent({
          ...replacement,
          error:
            "The new connection's history import is waiting on LinkedIn. The accounts merge when it finishes.",
        });
        continue;
      }
      // Force reconnect stores a new intent only while holding this account's leases, so
      // with them held the record checked here is the one the merge completes.
      if (!current()) {
        keepForMember();
        continue;
      }
      store.replaceAccount(a.key, connected, linkedInMatches());
      if (replacement.pauseBackfill) {
        const job = store.progress<Record<string, unknown>>(`backfill:${a.key}`);
        if (job)
          store.saveProgress(`backfill:${a.key}`, {
            ...job,
            stage: "blocked",
            resumeStage: "capture",
            pending: undefined,
            providerRun: undefined,
            nextAttemptAt: undefined,
            error: "Connection replaced. Resume the history import when you are ready.",
          });
      }
      saveIfCurrent({
        ...replacement,
        stage: "complete",
        newAccountId: connected.id,
        error: undefined,
      });
    } catch (e) {
      if (e instanceof LinkedInReplacementOwnerMismatchError) {
        // Nothing was merged and both records are as they were. The login stays open, so a
        // later pass retries once the records agree. No record is saved for the new
        // connection either: that would claim history whose owner is not proven.
        console.warn(
          `linkedin: replacement of ${a.key} left open: ${e.sourceKey} (owner: ${ownerLabel(e.sourceOwner)}) and ${a.key} (owner: ${ownerLabel(e.destinationOwner)}) have different owners`,
        );
        saveIfCurrent({ ...replacement, error: e.message });
        continue;
      }
      keepForMember();
      saveIfCurrent({
        ...replacement,
        stage: "failed",
        error: (e as Error).message,
      });
      throw e;
    } finally {
      for (const [key, token] of claims) review.release(key, token);
    }
  }
}
