import {
  currentWorkspaceName,
  demoMode,
  getLinkedInInboxStore,
  getReplyReviewStore,
  linkedInMatches,
  oneshotEnvReady,
} from "@oneshot-gtm/core";
import type {
  LinkedInAccount,
  LinkedInConversationsPage,
  LinkedInMessagesPage,
  LinkedInSyncStatus,
} from "@oneshot-agent/sdk";
import { adoptPendingLinkedInReplacements } from "./linkedin-replacement.ts";
import { callLinkedIn } from "./linkedin-client.ts";

interface Progress {
  cursor?: string;
  since?: string;
  started: string;
  complete?: boolean;
}
let active: Promise<void> | null = null;
let lastAttempt = 0;
export function refreshLinkedInInbox(force = false): Promise<void> {
  if (demoMode() || (!oneshotEnvReady() && !getLinkedInInboxStore().accounts().length))
    return Promise.resolve();
  if (active) return active;
  if (!force && Date.now() - lastAttempt < 60_000) return Promise.resolve();
  lastAttempt = Date.now();
  active = capture(force).finally(() => {
    active = null;
  });
  return active;
}

async function capture(force: boolean) {
  await adoptPendingLinkedInReplacements();
  const store = getLinkedInInboxStore();
  const review = getReplyReviewStore();
  const workspace = currentWorkspaceName();
  const owners = new Set(store.accounts().map((a) => a.workspace));
  if (oneshotEnvReady()) owners.add(workspace);
  for (const owner of owners) {
    try {
      const discovered = await callLinkedIn<{ wallet: string; accounts: LinkedInAccount[] }>(
        owner,
        { kind: "accounts" },
      );
      for (const account of discovered.accounts) {
        if (
          store
            .accounts()
            .some(
              (a) => a.wallet === discovered.wallet && a.previousAccountIds?.includes(account.id),
            )
        )
          continue;
        const old = store
          .accounts()
          .find((a) => a.wallet === discovered.wallet && a.account.id === account.id);
        if (old?.removedAt) continue;
        const key = old?.key ?? `${discovered.wallet}:${account.id}`;
        store.saveAccount({
          ...old,
          key,
          wallet: discovered.wallet,
          workspace: old?.workspace ?? owner,
          account,
          sync: old?.sync ?? null,
          checkedAt: old?.checkedAt ?? null,
          error: null,
          permissionUpgradeError: account.allowed_actions.includes("view_profile")
            ? undefined
            : old?.permissionUpgradeError,
        });
      }
    } catch (e) {
      for (const a of store.accounts().filter((a) => a.workspace === owner))
        store.saveAccount({ ...a, error: (e as Error).message });
      if (!store.accounts().length) throw e;
    }
  }
  const matches = linkedInMatches();
  // Every account is captured once, using the workspace that connected it.
  for (const a of store.accounts()) {
    if (
      a.removedAt ||
      a.account.status !== "connected" ||
      (!force && a.checkedAt && Date.now() - Date.parse(a.checkedAt) < 60_000)
    )
      continue;
    const token = review.claim(`capture:${a.key}`, 15 * 60_000);
    if (!token) continue;
    const heartbeat = setInterval(() => {
      review.db
        .query("UPDATE review_leases SET until_ms=? WHERE key=? AND token=?")
        .run(Date.now() + 15 * 60_000, `capture:${a.key}`, token);
    }, 30_000);
    try {
      a.sync = await callLinkedIn<LinkedInSyncStatus>(a.workspace, {
        kind: "status",
        accountId: a.account.id,
      });
      for (const resource of ["active", "archived", "messages"] as const) {
        const progressKey = `${a.key}:${resource}`;
        let p = store.progress<Progress>(progressKey);
        if (!p || p.complete)
          p = {
            started: new Date().toISOString(),
            since: p ? new Date(Date.parse(p.started) - 300_000).toISOString() : undefined,
          };
        // Bounded local capture, resumed on the next refresh without losing the window.
        for (let n = 0; n < 100; n++) {
          if (resource === "messages") {
            const page = await callLinkedIn<LinkedInMessagesPage>(a.workspace, {
              kind: "messages",
              options: {
                accountId: a.account.id,
                limit: 100,
                cursor: p.cursor,
                changedSince: p.since,
                includeDeleted: true,
              },
            });
            store.saveMessages(a.key, page.messages, a.account.id);
            if (page.has_more && (!page.next_cursor || page.next_cursor === p.cursor))
              throw new Error("LinkedIn returned an invalid message cursor");
            p.cursor = page.next_cursor ?? undefined;
            p.complete = !page.has_more;
          } else {
            const page = await callLinkedIn<LinkedInConversationsPage>(a.workspace, {
              kind: "conversations",
              options: {
                accountId: a.account.id,
                limit: 100,
                cursor: p.cursor,
                since: p.since,
                archived: resource === "archived",
              },
            });
            for (const c of page.conversations)
              store.saveConversation(a.key, c, matches, a.account.id);
            if (page.has_more && (!page.next_cursor || page.next_cursor === p.cursor))
              throw new Error("LinkedIn returned an invalid conversation cursor");
            p.cursor = page.next_cursor ?? undefined;
            p.complete = !page.has_more;
          }
          store.saveProgress(progressKey, p);
          if (p.complete) break;
        }
      }
      if (
        ["active", "archived", "messages"].every(
          (r) => store.progress<Progress>(`${a.key}:${r}`)?.complete,
        )
      )
        a.checkedAt = new Date().toISOString();
      a.error = null;
    } catch (e) {
      a.error = (e as Error).message;
    } finally {
      try {
        store.reconcileReplacementHistory(a.key);
        // A later page failure must not delay stop-on-reply for messages already captured.
        for (const t of store.threads(a.key)) {
          store.saveConversation(a.key, t.conversation, matches);
        }
        store.deliverAll(store.threads(a.key), matches);
      } catch (e) {
        a.error = a.error ?? (e as Error).message;
      }
      store.saveAccount(a);
      clearInterval(heartbeat);
      review.release(`capture:${a.key}`, token);
    }
  }
}
