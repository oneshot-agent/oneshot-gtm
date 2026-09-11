import {
  getLedger,
  hydrateMailboxThread,
  mailboxHealth,
  syncSmartleadMailboxes,
  verifyMailboxConnection,
} from "@oneshot-gtm/core";
import {
  saveMailboxConnection,
  validateMailboxConnection,
} from "../../../../packages/core/src/mailbox-config.ts";
import type {
  MailboxConnectionRequest,
  MailboxStateRequest,
  MailboxThreadView,
  InboxResult,
  ConversationItem,
} from "@oneshot-gtm/shared-types";
import { isLoopbackOrigin, jsonResponse } from "../server.ts";

export function mailboxInboxView(): Pick<InboxResult, "mailboxes" | "mailboxThreads"> {
  const health = mailboxHealth();
  const ledger = getLedger();
  const store = ledger.mailboxes;
  if (!health.length && !store?.all().length) return {};
  const identities = new Map(health.map((h) => [h.identityId, h.address]));
  const groups = new Map<string, ReturnType<typeof store.all>>();
  for (const message of store.all()) {
    const group = groups.get(message.threadKey) ?? [];
    group.push(message);
    groups.set(message.threadKey, group);
  }
  const drafts = ledger.getInboxThreads();
  const views: MailboxThreadView[] = [];
  for (const [threadKey, messages] of groups) {
    messages.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const latest = messages.findLast((m) => m.direction === "inbound");
    if (!latest) continue;
    const prospect = latest.prospectId == null ? null : ledger.getProspectById(latest.prospectId);
    const cadence = prospect
      ? (ledger.listCadencesForProspect(prospect.id).find((c) => c.status === "replied") ??
        ledger.listCadencesForProspect(prospect.id)[0])
      : null;
    const intents = ledger.listInboxReplyIntents(messages.map((m) => m.id));
    const draft = drafts.get(threadKey);
    const intent = intents.get(latest.id);
    const items: ConversationItem[] = messages.map((m) =>
      m.direction === "outbound"
        ? { kind: "sent", at: m.at, subject: m.subject, body: m.body }
        : {
            kind: "reply",
            at: m.at,
            subject: m.subject,
            body: m.body,
            id: m.id,
            threadKey,
            sourceIdentityId: m.identityId,
            threadId: threadKey,
            messageId: m.messageId,
            replyKind: m.kind,
            intent: (intents.get(m.id)?.intent as MailboxThreadView["reply"]["intent"]) ?? null,
          },
    );
    views.push({
      threadKey,
      identityId: latest.identityId,
      mailboxAddress:
        identities.get(latest.identityId) ?? latest.identityId.replace(/^smartlead:/, ""),
      prospectId: prospect?.id ?? null,
      name: prospect?.name ?? null,
      company: prospect?.company ?? null,
      email: latest.from,
      ...store.threadState(threadKey),
      lastActivityAt: messages.at(-1)!.at,
      items,
      reply: {
        bounceKind: latest.bounces?.[0]?.kind ?? null,
        id: latest.id,
        fromEmail: latest.from,
        fromRaw: latest.from,
        subject: latest.subject,
        receivedAt: latest.at,
        body: latest.body,
        kind: latest.kind,
        intent: (intent?.intent as MailboxThreadView["reply"]["intent"]) ?? null,
        intentReason: intent?.intentReason ?? null,
        // Removed identities retain history but cannot send.
        sourceIdentityId: identities.has(latest.identityId) ? latest.identityId : null,
        sourceProvider: "smartlead",
        threadId: threadKey,
        messageId: latest.messageId,
        matched: prospect
          ? {
              name: prospect.name,
              company: prospect.company,
              playName: cadence?.play_name ?? prospect.source,
              cadenceStatus: cadence?.status ?? null,
            }
          : null,
        thread: {
          draftBody: draft?.draftBody ?? null,
          steer: draft?.steer ?? null,
          status: draft?.status ?? null,
          sent: [],
        },
      },
    });
  }
  return {
    mailboxes: health,
    mailboxThreads: views.toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
  };
}

function allowed(req: Request): boolean {
  return isLoopbackOrigin(req.headers.get("origin") ?? "");
}

export async function mailboxStateRoute(req: Request): Promise<Response> {
  if (!allowed(req)) return jsonResponse({ error: "forbidden origin" }, 403, req);
  try {
    const b = (await req.json()) as MailboxStateRequest;
    if (
      typeof b.threadKey !== "string" ||
      !Array.isArray(b.observedReplyIds) ||
      !b.observedReplyIds.every((id) => typeof id === "string") ||
      (b.read !== undefined && typeof b.read !== "boolean") ||
      (b.archived !== undefined && typeof b.archived !== "boolean")
    )
      throw new Error("Invalid thread state request.");
    getLedger().mailboxes.changeState(b.threadKey, b.observedReplyIds, b);
    return jsonResponse({ ok: true }, 200, req);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Invalid thread state request." },
      409,
      req,
    );
  }
}

export async function mailboxMatchRoute(req: Request): Promise<Response> {
  if (!allowed(req)) return jsonResponse({ error: "forbidden origin" }, 403, req);
  try {
    const b = (await req.json()) as { threadKey?: string; email?: string };
    if (typeof b.threadKey !== "string" || typeof b.email !== "string")
      throw new Error("Thread and prospect email are required.");
    const ledger = getLedger();
    const prospect = ledger.getProspectByEmail(b.email.trim().toLowerCase());
    if (!prospect) throw new Error("No existing prospect has that email address.");
    if (!ledger.mailboxes.thread(b.threadKey).length) throw new Error("Conversation not found.");
    ledger.mailboxes.associate(b.threadKey, prospect.id);
    return jsonResponse({ ok: true }, 200, req);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Could not match conversation." },
      400,
      req,
    );
  }
}

export async function mailboxHistoryRoute(req: Request): Promise<Response> {
  if (!allowed(req)) return jsonResponse({ error: "forbidden origin" }, 403, req);
  try {
    const b = (await req.json()) as { threadKey?: string };
    if (typeof b.threadKey !== "string") throw new Error("Thread is required.");
    await hydrateMailboxThread(b.threadKey);
    return jsonResponse({ ok: true }, 200, req);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Could not load history." },
      400,
      req,
    );
  }
}

export async function mailboxRefreshRoute(req: Request): Promise<Response> {
  if (!allowed(req)) return jsonResponse({ error: "forbidden origin" }, 403, req);
  await syncSmartleadMailboxes(true);
  return jsonResponse(mailboxInboxView(), 200, req);
}

export async function mailboxConnectRoute(req: Request): Promise<Response> {
  if (!allowed(req)) return jsonResponse({ error: "forbidden origin" }, 403, req);
  try {
    const b = (await req.json()) as MailboxConnectionRequest;
    const identity = mailboxHealth().find(
      (h) => h.identityId === b.identityId && h.address.toLowerCase() === b.address?.toLowerCase(),
    );
    if (!identity) throw new Error("Mailbox is not registered in this workspace.");
    const connection = validateMailboxConnection(b);
    await verifyMailboxConnection(connection);
    saveMailboxConnection(b.identityId, connection);
    await syncSmartleadMailboxes(true);
    return jsonResponse({ ok: true }, 200, req);
  } catch {
    // Never forward credential-bearing transport errors or arbitrary input to the browser.
    return jsonResponse(
      { error: "Could not connect this mailbox. Check both IMAP and SMTP settings and try again." },
      400,
      req,
    );
  }
}
