import { getLinkedInInboxStore, getReplyReviewStore, linkedInMatches } from "@oneshot-gtm/core";
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

/** Only consumes an explicitly authorized, persisted replacement intent. Never revokes accounts. */
export async function adoptPendingLinkedInReplacements() {
  const store = getLinkedInInboxStore();
  const review = getReplyReviewStore();
  for (const a of store.accounts()) {
    if (a.removedAt) continue;
    const progressKey = `replacement:${a.key}`;
    const replacement = store.progress<Replacement>(progressKey);
    if (replacement?.stage !== "awaiting_login" || !replacement.intentId) continue;
    const result = await callLinkedIn<{
      status: string;
      failure_reason?: string;
      account?: LinkedInAccount | null;
    }>(a.workspace, { kind: "connection", intentId: replacement.intentId });
    if (["pending", "verifying"].includes(result.status)) continue;
    if (result.status !== "completed" || !result.account) {
      store.saveProgress(progressKey, {
        ...replacement,
        stage: "failed",
        error: result.failure_reason ?? result.status,
      });
      continue;
    }
    const newKey = `${a.wallet}:${result.account.id}`;
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
      if (claims.length !== required || store.account(a.key)?.removedAt) continue;
      store.replaceAccount(a.key, result.account, linkedInMatches());
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
      store.saveProgress(progressKey, {
        ...replacement,
        stage: "complete",
        newAccountId: result.account.id,
      });
    } catch (e) {
      store.saveProgress(progressKey, {
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
