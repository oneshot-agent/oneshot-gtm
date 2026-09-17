import type {
  ConversationItem,
  InboxReplyView,
  InboxResult,
  ReplyMessage,
  ReplyThread,
} from "./index.ts";

const provider = (identity: string | null): InboxReplyView["sourceProvider"] =>
  !identity
    ? null
    : identity.startsWith("gmail:") || identity === "legacy-gmail"
      ? "gmail"
      : identity.startsWith("smartlead:")
        ? "smartlead"
        : "oneshot";
function messages(items: ConversationItem[]): ReplyMessage[] {
  return items.map((i, n) => ({
    id: i.kind === "reply" ? i.id : `${i.kind}:${i.at}:${n}`,
    direction: i.kind === "reply" ? "inbound" : "outbound",
    body: i.body ?? "",
    at: i.at,
    human: i.kind !== "reply" || i.replyKind === "human",
  }));
}
export function emailThreads(
  inbox: InboxResult,
  workspace: string,
  findProspect: (email: string) => number | null = () => null,
): ReplyThread[] {
  const out: ReplyThread[] = [];
  const included = new Set<string>();
  function add(
    key: string,
    r: InboxReplyView,
    history: ReplyMessage[],
    prospectId: number | null,
    archivedAt: string | null,
    extra: Partial<ReplyThread> = {},
  ) {
    history.forEach((m) => included.add(m.id));
    const name = r.matched?.name ?? r.fromRaw ?? r.fromEmail;
    const last = history.findLast((m) => !m.deleted && m.human);
    out.push({
      key: `email:${workspace}:${key}`,
      channel: "email",
      name,
      company: r.matched?.company ?? null,
      subject: r.subject,
      address: r.fromEmail,
      workspace,
      prospectId,
      messages: history,
      lastActivityAt: history.at(-1)?.at ?? r.receivedAt,
      archivedAt,
      snoozedUntil: null,
      needsReply: last?.direction === "inbound",
      canSend: !!r.sourceIdentityId,
      canGenerate: !!r.body.trim() && r.kind === "human",
      contextVersion: "",
      drafts: null,
      send: null,
      email: r,
      ...extra,
    });
  }
  for (const t of inbox.mailboxThreads ?? [])
    add(`mailbox:${t.threadKey}`, t.reply, messages(t.items), t.prospectId, t.archivedAt, {
      mailboxThreadKey: t.threadKey,
      historyComplete: t.historyComplete,
    });
  for (const c of inbox.conversations ?? []) {
    const inbound = c.items.filter(
      (i): i is Extract<ConversationItem, { kind: "reply" }> =>
        i.kind === "reply" && !i.id.startsWith("mailbox:"),
    );
    const newest = inbound.at(-1);
    if (!newest) continue;
    const live = inbox.replies.find((r) => r.id === newest.id);
    const r: InboxReplyView = live ?? {
      id: newest.id,
      kind: newest.replyKind,
      intent: newest.intent,
      intentReason: null,
      fromEmail: c.email,
      fromRaw: c.name ?? c.email,
      subject: newest.subject ?? "",
      receivedAt: newest.at,
      body: newest.body,
      sourceIdentityId: newest.sourceIdentityId,
      sourceProvider: provider(newest.sourceIdentityId),
      threadId: newest.threadId,
      messageId: newest.messageId,
      matched: {
        name: c.name,
        company: c.company,
        playName: c.playName,
        cadenceStatus: c.cadenceStatus,
      },
      thread: { draftBody: c.draftBody, sent: [], steer: c.steer, status: c.status },
    };
    add(
      `prospect:${c.prospectId}`,
      r,
      messages(c.items.filter((i) => i.kind !== "reply" || !i.id.startsWith("mailbox:"))),
      c.prospectId,
      c.archivedAt,
    );
  }
  const groups = new Map<string, InboxReplyView[]>();
  for (const r of inbox.replies) {
    if (included.has(r.id) || r.sourceProvider === "smartlead") continue;
    const key = `${r.sourceIdentityId ?? "unknown"}:${r.threadId ?? r.id}`;
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const r = rows.at(-1)!;
    const history: ReplyMessage[] = rows.map((r) => ({
      id: r.id,
      direction: "inbound",
      body: r.body,
      at: r.receivedAt,
      human: r.kind === "human",
    }));
    for (const s of r.thread?.sent ?? [])
      history.push({
        id: `sent:${s.sentAt}`,
        direction: "outbound",
        body: s.body,
        at: s.sentAt,
        human: true,
      });
    history.sort((a, b) => a.at.localeCompare(b.at));
    add(key, r, history, findProspect(r.fromEmail), null);
  }
  return out;
}
