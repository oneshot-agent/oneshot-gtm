import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  verifiedLinkedInProfileKey,
  getLinkedInInboxStore,
  getReplyReviewStore,
  linkedInMatches,
  type LinkedInWorkspaceCounts,
  type LinkedInOperation,
} from "@oneshot-gtm/core";
import type { LinkedInSyncStatus } from "@oneshot-agent/sdk";
import { adoptPendingLinkedInReplacements } from "./linkedin-replacement.ts";
import { callLinkedIn } from "./linkedin-client.ts";
import { refreshLinkedInInbox } from "./linkedin-sync.ts";

export interface LinkedInBackfill {
  id: string;
  accountKey: string;
  stage: "capture" | "resolve" | "replay" | "provider" | "waiting" | "blocked" | "complete";
  resumeStage?: LinkedInBackfill["stage"];
  pending?: {
    kind: "profile" | "sync";
    /** The key was replaced once after the provider refused it without a request id. */
    rekeyed?: boolean;
    identifier?: string;
    idempotencyKey: string;
    requestId?: string;
  };
  counts: Record<string, LinkedInWorkspaceCounts>;
  failures: Array<{
    at: string;
    message: string;
    requestId?: string;
    code?: string;
    statusCode?: number;
  }>;
  updatedAt: string;
  error?: string;
  providerRun?: string;
  nextAttemptAt?: string;
  providerLimit?: { limit: number; used: number; pending: number; resetsAt: string };
  senders?: { total: number; resolved: number; failed?: number };
}
const key = (accountKey: string) => `backfill:${accountKey}`;
export function backfillStatus(accountKey: string) {
  return getLinkedInInboxStore().progress<LinkedInBackfill>(key(accountKey));
}
function save(job: LinkedInBackfill) {
  job.updatedAt = new Date().toISOString();
  getLinkedInInboxStore().saveProgress(key(job.accountKey), job);
}
export function startLinkedInBackfill(accountKey: string) {
  const store = getLinkedInInboxStore();
  if (store.account(accountKey)?.removedAt)
    throw new Error("This LinkedIn account has been removed.");
  if (!store.account(accountKey)) throw new Error("LinkedIn account not found");
  const review = getReplyReviewStore();
  const token = review.claim(key(accountKey), 120_000);
  if (!token) return backfillStatus(accountKey);
  try {
    let job = backfillStatus(accountKey);
    if (!job || job.stage === "complete") {
      job = {
        id: randomUUID(),
        accountKey,
        stage: "capture",
        counts: {},
        failures: [],
        updatedAt: "",
      };
      // Start with a complete local enumeration, including older imported records.
      for (const resource of ["active", "archived", "messages"])
        store.saveProgress(`${accountKey}:${resource}`, { started: new Date().toISOString() });
    } else if (job.stage === "blocked") {
      job.stage = job.resumeStage ?? "capture";
      delete job.error;
    }
    save(job);
    return job;
  } finally {
    review.release(key(accountKey), token);
  }
}

/** One bounded tick; leases and accepted request IDs live in shared private SQLite. */
export async function runLinkedInBackfill(accountKey: string) {
  const store = getLinkedInInboxStore();
  const review = getReplyReviewStore();
  const token = review.claim(key(accountKey), 120_000);
  if (!token) return;
  const heartbeat = setInterval(() => {
    review.db
      .query("UPDATE review_leases SET until_ms=? WHERE key=? AND token=?")
      .run(Date.now() + 120_000, key(accountKey), token);
  }, 20_000);
  const job = backfillStatus(accountKey);
  try {
    if (store.account(accountKey)?.removedAt) return;
    if (!job || ["blocked", "complete"].includes(job.stage)) return;
    if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()) return;
    delete job.nextAttemptAt;
    const a = store.account(accountKey)!;
    if (job.stage === "capture") {
      await refreshLinkedInInbox(true);
      const latest = store.account(accountKey)!;
      if (latest.error) throw new Error(latest.error);
      if (
        !["active", "archived", "messages"].every(
          (r) => store.progress<{ complete?: boolean }>(`${accountKey}:${r}`)?.complete,
        )
      )
        return;
      // A replaced connection has no provider conversation IDs yet. Start its initial
      // import before paid identity scans so preserved threads can become writable again.
      job.stage = latest.sync?.sync_state === "never_synced" ? "provider" : "resolve";
      save(job);
    }
    const matches = linkedInMatches();
    if (job.stage === "resolve") {
      const latest = store.account(accountKey)!;
      // The same provider sender is resolved only once, shared by every workspace.
      const senders = new Map<string, string>();
      const conversations = new Map(
        store.threads(accountKey).map((t) => [t.conversation.id, t.conversation]),
      );
      for (const m of store.allMessages(accountKey))
        if (m.direction === "inbound" && !m.deleted && m.sender_provider_id) {
          const c = conversations.get(m.conversation_id);
          const peer = c?.attendees.find((p) => p.provider_id === m.sender_provider_id);
          senders.set(
            m.sender_provider_id,
            m.sender_name?.trim() ||
              senders.get(m.sender_provider_id) ||
              peer?.name ||
              (c && c.attendees.filter((p) => !p.is_self).length <= 1 ? c.name : "") ||
              "",
          );
        }
      job.senders = {
        total: senders.size,
        resolved: [...senders.keys()].filter((id) => store.identity(accountKey, id)).length,
        failed: [...senders.keys()].filter((id) => store.identity(accountKey, id)?.failure).length,
      };
      const activeNames = new Set<string>();
      for (const home of new Set(matches.map((m) => m.home))) {
        const db = new Database(join(home, "ledger.sqlite"), { readonly: true });
        try {
          const ids = new Set(
            (
              db
                .query(
                  "SELECT DISTINCT prospect_id FROM cadence_state WHERE status IN ('active','paused')",
                )
                .all() as { prospect_id: number }[]
            ).map((r) => r.prospect_id),
          );
          for (const m of matches.filter((m) => m.home === home && ids.has(m.prospectId)))
            activeNames.add(m.name.trim().toLowerCase());
        } finally {
          db.close();
        }
      }
      // A completed identity write may survive a crash before the pending marker clears.
      if (job.pending?.kind === "profile" && store.identity(accountKey, job.pending.identifier!)) {
        delete job.pending;
        save(job);
      }
      const activeParts = new Set(
        [...activeNames].flatMap((name) => name.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
      );
      const priority = (id: string) => {
        const name = senders.get(id)?.trim().toLowerCase() ?? "";
        if (activeNames.has(name)) return 100;
        return (name.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((part) => activeParts.has(part))
          .length;
      };
      const identifiers = [...senders.keys()]
        .filter((id) => !store.identity(accountKey, id))
        .toSorted((a, b) => priority(b) - priority(a));
      if (job.pending?.identifier) {
        const i = identifiers.indexOf(job.pending.identifier);
        if (i >= 0) identifiers.splice(i, 1);
        identifiers.unshift(job.pending.identifier);
      }
      const deadline = Date.now() + 25_000;
      for (const identifier of identifiers) {
        if (!job.pending && latest.sync?.sync_state === "never_synced") {
          job.stage = "provider";
          save(job);
          break;
        }
        if (!latest.account.allowed_actions.includes("view_profile"))
          throw Object.assign(
            new Error(
              "Grant profile lookup access using Upgrade permissions, then resume backfill.",
            ),
            { code: "view_profile_required", statusCode: 403 },
          );
        if (!job.pending) {
          const limit = job.providerLimit;
          if (
            limit &&
            limit.used + limit.pending >= limit.limit &&
            Date.parse(limit.resetsAt) > Date.now()
          ) {
            job.nextAttemptAt = limit.resetsAt;
            save(job);
            return;
          }
          job.pending = { kind: "profile", identifier, idempotencyKey: randomUUID() };
          save(job); // Key survives a crash between provider acceptance and saving request ID.
        }
        const result = await paidStep(job, a.workspace, {
          kind: "profile",
          accountId: a.account.id,
          identifier: job.pending.identifier!,
          idempotencyKey: job.pending.idempotencyKey,
        });
        if (!result) return;
        const profile = result.profile as
          | { provider_id?: string; public_identifier?: string; name?: string }
          | undefined;
        if (!profile) throw new Error("Profile lookup completed without identity evidence");
        if (profile.provider_id && profile.provider_id !== job.pending.identifier)
          throw new Error("Profile lookup returned a different provider identity");
        store.saveIdentity(accountKey, {
          providerId: job.pending.identifier!,
          profile: profile.public_identifier
            ? verifiedLinkedInProfileKey(
                `https://www.linkedin.com/in/${encodeURIComponent(profile.public_identifier)}`,
                profile.provider_id,
              )
            : null,
          name: profile.name ?? null,
          resolvedAt: new Date().toISOString(),
          requestId: job.pending.requestId,
        });
        delete job.pending;
        job.senders.resolved++;
        save(job);
        // Suppress confirmed replies promptly, even if a later lookup fails.
        replay(accountKey, matches);
        if (Date.now() >= deadline) return;
      }
      if (job.stage === "resolve") {
        job.stage = "replay";
        save(job);
      }
    }
    if (job.stage === "replay") {
      replay(accountKey, matches);
      job.stage = "provider";
      save(job);
    }
    if (job.stage === "provider" || job.stage === "waiting") {
      if (job.pending) {
        const result = await paidStep(job, a.workspace, {
          kind: "sync",
          accountId: a.account.id,
          idempotencyKey: job.pending.idempotencyKey,
        });
        if (!result) return;
        delete job.pending;
        job.stage = "capture";
        save(job);
        return;
      }
      const status = await callLinkedIn<LinkedInSyncStatus>(a.workspace, {
        kind: "status",
        accountId: a.account.id,
      });
      store.saveAccount({ ...store.account(accountKey)!, sync: status });
      if (
        status.active_run ||
        status.sync_state === "syncing" ||
        ["requested", "running"].includes(status.coverage.provider_history)
      ) {
        job.stage = "waiting";
      } else if (status.coverage.complete) {
        // Capture the final provider pages before declaring success.
        if (job.stage === "waiting") job.stage = "capture";
        else job.stage = "complete";
      } else if (
        status.coverage.provider_history === "error" ||
        status.sync_state === "reconnect_required"
      ) {
        throw new Error(
          "Provider history or connection requires attention; coverage remains incomplete.",
        );
      } else if (
        status.coverage.pending_cursor ||
        status.sync_state === "never_synced" ||
        (status.coverage.provider_history === "done" &&
          (!status.coverage.enumerated_as_of ||
            (status.coverage.provider_history_completed_at &&
              Date.parse(status.coverage.enumerated_as_of) <
                Date.parse(status.coverage.provider_history_completed_at))))
      ) {
        const run = status.last_run?.run_id ?? "initial";
        if (job.providerRun === run) {
          job.stage = "waiting"; // Do not buy a second run while status catches up.
        } else {
          job.providerRun = run;
          job.pending = { kind: "sync", idempotencyKey: randomUUID() };
          save(job);
          const result = await paidStep(job, a.workspace, {
            kind: "sync",
            accountId: a.account.id,
            idempotencyKey: job.pending.idempotencyKey,
          });
          if (!result) return;
          delete job.pending;
          job.stage = "capture";
        }
      } else {
        job.stage = "waiting";
      }
      save(job);
    }
  } catch (e) {
    if (job) {
      const error = e as Error & {
        requestId?: string;
        jobId?: string;
        code?: string;
        statusCode?: number;
      };
      const requestId = error.requestId ?? error.jobId;
      if (job.pending && requestId) job.pending.requestId = requestId;
      if (/timeout/i.test(error.name) && job.pending?.requestId) {
        save(job);
        return;
      }
      // The key is kept across a failure so an accepted lookup is never bought
      // twice — but the provider can consume a key without ever handing back
      // a request id (a dispatch failure that was recorded upstream). Then the
      // same key is refused on every retry and there is nothing to wait on:
      // resubmitting under a fresh key is the only way forward. Once, and
      // logged, so a lookup that keeps failing still ends in "blocked".
      if (
        job.pending &&
        !job.pending.requestId &&
        !job.pending.rekeyed &&
        /idempotency-key was already used/i.test(error.message)
      ) {
        job.failures.push({ at: new Date().toISOString(), message: error.message });
        job.pending = { ...job.pending, idempotencyKey: randomUUID(), rekeyed: true };
        delete job.error;
        save(job);
        return;
      }
      // A terminal rejection belongs to this lookup, not every sender in the inbox.
      // Preserve evidence, never purchase it again, and leave its messages unresolved.
      if (
        job.stage === "resolve" &&
        job.pending?.kind === "profile" &&
        job.pending.requestId &&
        job.pending.identifier &&
        ["content_rejected", "target_not_found"].includes(error.code ?? "")
      ) {
        store.saveIdentity(accountKey, {
          providerId: job.pending.identifier,
          profile: null,
          name: null,
          resolvedAt: new Date().toISOString(),
          requestId: job.pending.requestId,
          failure: { code: error.code!, message: error.message },
        });
        if (!job.failures.some((f) => f.requestId === job.pending!.requestId))
          job.failures.push({
            at: new Date().toISOString(),
            message: error.message,
            requestId: job.pending.requestId,
            code: error.code,
          });
        delete job.pending;
        delete job.error;
        if (job.senders) {
          job.senders.resolved++;
          job.senders.failed = (job.senders.failed ?? 0) + 1;
        }
        save(job);
        return;
      }
      job.resumeStage = job.stage;
      job.stage = "blocked";
      job.error = error.message;
      job.failures.push({
        at: new Date().toISOString(),
        message: error.message,
        requestId,
        code: error.code,
        statusCode: error.statusCode,
      });
      save(job);
    }
  } finally {
    if (job) {
      job.counts = store.counts(accountKey, linkedInMatches());
      save(job);
    }
    clearInterval(heartbeat);
    review.release(key(accountKey), token);
  }
}
function replay(accountKey: string, matches: ReturnType<typeof linkedInMatches>) {
  const store = getLinkedInInboxStore();
  store.reconcileReplacementHistory(accountKey);
  for (const t of store.threads(accountKey))
    store.saveConversation(accountKey, t.conversation, matches);
  store.deliverAll(store.threads(accountKey), matches);
}
async function paidStep(
  job: LinkedInBackfill,
  workspace: string,
  operation: LinkedInOperation,
): Promise<Record<string, unknown> | null> {
  const pending = job.pending!;
  const result = await callLinkedIn<Record<string, unknown>>(
    workspace,
    pending.requestId ? { kind: "wait", requestId: pending.requestId } : operation,
  );
  if (typeof result.request_id === "string") pending.requestId = result.request_id;
  const headroom = (result.linkedin as { headroom?: Record<string, unknown> } | undefined)
    ?.headroom;
  if (
    pending.kind === "profile" &&
    headroom &&
    typeof headroom.limit === "number" &&
    typeof headroom.used === "number" &&
    typeof headroom.pending === "number" &&
    typeof headroom.resets_at === "string" &&
    Number.isFinite(Date.parse(headroom.resets_at))
  ) {
    job.providerLimit = {
      limit: headroom.limit,
      used: headroom.used,
      pending: headroom.pending,
      resetsAt: headroom.resets_at,
    };
  }
  save(job);
  if (["pending", "processing", "queued", "running"].includes(String(result.status))) {
    if (!pending.requestId) throw new Error("Provider accepted work without a request ID");
    return null;
  }
  if (["failed", "error"].includes(String(result.status)))
    throw new Error(String(result.error ?? "LinkedIn provider job failed"));
  return (result.result && typeof result.result === "object" ? result.result : result) as Record<
    string,
    unknown
  >;
}
let running = false;
export async function resumeLinkedInBackfills() {
  if (running) return;
  running = true;
  try {
    await adoptPendingLinkedInReplacements();
    for (const a of getLinkedInInboxStore().accounts()) {
      const job = backfillStatus(a.key);
      if (
        job &&
        (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= Date.now()) &&
        !["blocked", "complete"].includes(job.stage)
      )
        await runLinkedInBackfill(a.key);
    }
  } finally {
    running = false;
  }
}
