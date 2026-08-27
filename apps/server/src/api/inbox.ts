import {
  classifyReply,
  getGmailProfile,
  getLedger,
  isDraining,
  listInbox,
  listRepliesFrom,
  loadConfig,
  logEvent,
  replyEmail,
  resolveIdentities,
  trackSend,
  type ReplyKind,
} from "@oneshot-gtm/core";
import { draftInboxReply } from "@oneshot-gtm/plays";
import {
  type ConversationItem,
  type ConversationView,
  type InboxDraftReplyRequest,
  type InboxDraftReplyResult,
  type InboxReplyView,
  type InboxResult,
  type InboxSaveDraftRequest,
  type InboxSaveDraftResult,
  type InboxSendReplyRequest,
  type InboxSendReplyResult,
  inboxThreadKey,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { gatherReplyContext } from "./_reply-research.ts";

/** "Jane Doe <jane@x.com>" → "jane@x.com"; bare addresses pass through. */
function normalizeFrom(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? (m[1] ?? raw) : raw).trim().toLowerCase();
}

/**
 * Cadence-status priority: `replied` wins, then `active`. Shared by the list
 * and draft routes so the play shown and the play whose history feeds the LLM
 * never diverge. Ties keep the first row seen.
 */
function cadenceRank(status: string): number {
  if (status === "replied") return 2;
  if (status === "active") return 1;
  return 0;
}

/**
 * Read-only view of the OneShot inbox (replies to outreach). Each email is
 * matched to a known prospect by sender address, annotated with the play +
 * cadence status when available. Live fetch — no storage. The SDK exposes only
 * inboxList (no reply/markRead), so this is read-only.
 */
export async function listInboxRoute(req: Request): Promise<Response> {
  const ledger = getLedger();

  let emails: Awaited<ReturnType<typeof listInbox>>["emails"];
  let hasMore = false;
  try {
    // Wide window: matching only runs over what's fetched, and mailbox noise
    // would bury a genuine prospect reply in a small one.
    const result = await listInbox({ limit: 200 });
    emails = result.emails;
    // Truthful truncation signal — the page must never present a clamped
    // window as the entire mailbox.
    hasMore = result.has_more;
    // Known repliers get a targeted all-time fetch on top of the window: the
    // ledger knows who replied, and their mail must never be pushed out by
    // noise or the broad query's 30d recency cutoff. Best-effort in its own
    // try — a supplement failure must not take down the main list.
    try {
      const repliedEmails = ledger.listRepliedProspectEmails();
      if (repliedEmails.length > 0) {
        const targeted = await listRepliesFrom(repliedEmails);
        const seen = new Set(emails.map((e) => e.id));
        const extra = targeted.filter((e) => !seen.has(e.id));
        if (extra.length > 0) {
          emails = [...emails, ...extra].sort(
            (a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
          );
        }
      }
    } catch (err) {
      logEvent(
        "inbox.replies_from_failed",
        { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
        "warn",
      );
    }
  } catch (err) {
    logEvent(
      "inbox.list_failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    // The live window is gone, but the ledger isn't: conversations still
    // render so a mailbox outage never empties the matched view.
    let conversations: ConversationView[] = [];
    try {
      conversations = buildConversations(ledger, cadenceIndex(ledger), ledger.getInboxThreads());
    } catch {
      // degraded twice over — return the error state alone.
    }
    const out: InboxResult = {
      replies: [],
      conversations,
      hasMore: false,
      error: "couldn't reach the inbox",
    };
    return jsonResponse(out, 200, req);
  }

  const byEmail = cadenceIndex(ledger);

  // Provider per identity — the UI shows whether a reply threads (gmail) or
  // is a best-effort OneShot send.
  const cfg = loadConfig();
  const providerById = new Map(resolveIdentities(cfg).map((i) => [i.id, i.provider]));

  // Persisted reply activity (saved draft + sent history), indexed by thread_key.
  const threads = ledger.getInboxThreads();

  const replies: InboxReplyView[] = emails.map((e) => {
    const fromEmail = normalizeFrom(e.from);
    let matched: InboxReplyView["matched"] = null;
    const cadence = byEmail.get(fromEmail);
    if (cadence) {
      matched = {
        name: cadence.name,
        company: cadence.company,
        playName: cadence.playName,
        cadenceStatus: cadence.status,
      };
    } else {
      // One-touch plays leave no cadence row — fall back to the prospect record.
      const p = ledger.getProspectByEmail(fromEmail);
      if (p) {
        matched = { name: p.name, company: p.company, playName: p.source, cadenceStatus: null };
      }
    }
    const threadId = e.thread_id ?? null;
    return {
      id: e.id,
      fromEmail,
      fromRaw: e.from,
      subject: e.subject,
      receivedAt: e.received_at,
      body: e.body ?? "",
      kind: classifyReply({ subject: e.subject, body: e.body, autoSubmitted: e.auto_submitted }),
      sourceIdentityId: e.source_identity_id ?? null,
      sourceProvider: e.source_identity_id
        ? (providerById.get(e.source_identity_id) ?? null)
        : null,
      threadId,
      messageId: e.message_id ?? null,
      matched,
      thread: threads.get(inboxThreadKey({ threadId, id: e.id })) ?? null,
    };
  });

  // Drop mail from the founder's own sending domain (agent's own sends +
  // system test mail are never prospect replies). Then newest-first.
  const selfDomain = (cfg.sendingDomain ?? "").trim().toLowerCase();
  // Gmail self-sends: belt-and-braces on top of the query's `-from:me`. Only
  // the legacy synthesized identity (no address in config) needs a live
  // profile lookup, and that failing must not break the replies page.
  const gmailIdentities = resolveIdentities(cfg).filter((i) => i.provider === "gmail");
  const selfAddresses = new Set(
    gmailIdentities.map((i) => (i.address ?? "").trim().toLowerCase()).filter((a) => a.length > 0),
  );
  if (gmailIdentities.some((i) => !i.address)) {
    try {
      selfAddresses.add((await getGmailProfile()).emailAddress.trim().toLowerCase());
    } catch {
      // best-effort — `-from:me` already filters at the source.
    }
  }
  const visible = replies
    .filter((r) => !selfDomain || !r.fromEmail.endsWith(`@${selfDomain}`))
    .filter((r) => !selfAddresses.has(r.fromEmail))
    .toSorted((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));

  // Opportunistic capture: any matched live mail not yet persisted goes into
  // inbox_replies now (INSERT OR IGNORE — re-sees are no-ops). This is also
  // how pre-v21 history backfills itself: the targeted known-replier fetch
  // above flows through here on first load. Best-effort.
  try {
    for (const r of visible) {
      if (!r.matched) continue;
      const p = ledger.findProspectByEmail(r.fromEmail);
      if (!p) continue;
      ledger.recordInboxReply({
        id: r.id,
        threadKey: inboxThreadKey({ threadId: r.threadId, id: r.id }),
        prospectId: p.id,
        playName: r.matched.playName,
        fromEmail: r.fromEmail,
        subject: r.subject,
        body: r.body,
        receivedAt: r.receivedAt,
        sourceIdentityId: r.sourceIdentityId,
        threadId: r.threadId,
        messageId: r.messageId,
        kind: r.kind,
      });
    }
  } catch (err) {
    logEvent(
      "inbox.reply_capture_failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
  }

  // Threaded matched view, built from the ledger (complete regardless of the
  // live window): outreach steps + persisted inbound replies + manual replies
  // sent from /inbox, merged per prospect and sorted oldest-first.
  let conversations: ConversationView[] = [];
  try {
    conversations = buildConversations(ledger, byEmail, threads);
  } catch (err) {
    logEvent(
      "inbox.conversations_failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
  }

  const out: InboxResult = { replies: visible, conversations, hasMore };
  return jsonResponse(out, 200, req);
}

/**
 * Index cadence-backed prospects by normalized email; prefer a
 * `replied`/`active` cadence when a prospect has several.
 */
function cadenceIndex(
  ledger: ReturnType<typeof getLedger>,
): Map<string, { name: string | null; company: string | null; playName: string; status: string }> {
  const byEmail = new Map<
    string,
    { name: string | null; company: string | null; playName: string; status: string }
  >();
  for (const c of ledger.listAllCadences()) {
    if (!c.prospect_email) continue;
    const key = c.prospect_email.trim().toLowerCase();
    const existing = byEmail.get(key);
    const better = !existing || cadenceRank(c.status) > cadenceRank(existing.status);
    if (better) {
      byEmail.set(key, {
        name: c.prospect_name,
        company: c.prospect_company,
        playName: c.play_name,
        status: c.status,
      });
    }
  }
  return byEmail;
}

/** Assemble one ConversationView per prospect with at least one persisted reply. */
function buildConversations(
  ledger: ReturnType<typeof getLedger>,
  byEmail: Map<
    string,
    { name: string | null; company: string | null; playName: string; status: string }
  >,
  threads: ReturnType<ReturnType<typeof getLedger>["getInboxThreads"]>,
): ConversationView[] {
  const out: ConversationView[] = [];
  for (const prospectId of ledger.listProspectIdsWithReplies()) {
    const prospect = ledger.getProspectById(prospectId);
    if (!prospect?.email) continue;
    const inbound = ledger.listInboxRepliesForProspect(prospectId);
    if (inbound.length === 0) continue;

    const items: ConversationItem[] = [];
    for (const ev of ledger.listSequenceEventsForProspect(prospectId)) {
      if (ev.channel !== "email") continue;
      let subject: string | null = null;
      let body: string | null = null;
      try {
        const meta = JSON.parse(ev.metadata_json ?? "{}") as Record<string, unknown>;
        if (typeof meta["subject"] === "string") subject = meta["subject"];
        if (typeof meta["body"] === "string") body = meta["body"];
      } catch {
        // pre-v8 / malformed metadata — render the step with no body.
      }
      items.push({
        kind: "outreach",
        at: sqliteToIso(ev.created_at),
        subject,
        body,
        stepIndex: ev.step_index,
        playName: ev.play_name,
      });
    }
    const threadKeys = new Set<string>();
    for (const r of inbound) {
      threadKeys.add(r.thread_key);
      items.push({
        kind: "reply",
        at: r.received_at,
        subject: r.subject,
        body: r.body,
        id: r.id,
        threadKey: r.thread_key,
        sourceIdentityId: r.source_identity_id,
        threadId: r.thread_id,
        messageId: r.message_id,
        replyKind: (r.kind as ReplyKind | null) ?? "human",
      });
    }
    for (const key of threadKeys) {
      for (const s of threads.get(key)?.sent ?? []) {
        items.push({ kind: "sent", at: s.sentAt, subject: null, body: s.body });
      }
    }
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const cadence = byEmail.get(prospect.email.trim().toLowerCase());
    out.push({
      prospectId,
      name: prospect.name,
      company: prospect.company,
      email: prospect.email,
      playName: cadence?.playName ?? inbound.at(-1)?.play_name ?? prospect.source,
      cadenceStatus: cadence?.status ?? null,
      lastActivityAt: items.at(-1)?.at ?? inbound.at(-1)!.received_at,
      draftBody: threads.get(inbound.at(-1)!.thread_key)?.draftBody ?? null,
      items,
    });
  }
  // Most recent activity first — the row order of the matched tab.
  return out.toSorted((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
}

/**
 * sequence_events.created_at is SQLite datetime('now') format ("YYYY-MM-DD
 * HH:MM:SS", UTC, no 'T'/'Z'); inbox timestamps are ISO. Normalize so the
 * merged timeline's string sort is chronological.
 */
function sqliteToIso(ts: string): string {
  return ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
}

/**
 * Generate an LLM reply draft for an inbound email. The client sends the
 * email content it already has (re-fetching the inbox costs seconds);
 * prospect/play context is re-resolved from the ledger by sender address.
 */
export async function draftReplyRoute(req: Request): Promise<Response> {
  let body: Partial<InboxDraftReplyRequest>;
  try {
    body = (await req.json()) as Partial<InboxDraftReplyRequest>;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const fromEmail = (body.fromEmail ?? "").trim().toLowerCase();
  const subject = (body.subject ?? "").trim();
  const inboundBody = (body.body ?? "").trim();
  if (!fromEmail) {
    return jsonResponse({ error: "fromEmail is required" }, 400, req);
  }
  // Distinct message so a scripted caller knows WHY this 400s.
  if (!inboundBody) {
    return jsonResponse({ error: "this email has no body to draft a reply from" }, 400, req);
  }

  const ledger = getLedger();
  const prospect = ledger.getProspectByEmail(fromEmail);
  let matched: Parameters<typeof draftInboxReply>[0]["matched"] = null;
  if (prospect) {
    // Same ranking as the list route's badge (cadenceRank).
    const cadences = ledger.listCadencesForProspect(prospect.id);
    const best = cadences.reduce<(typeof cadences)[number] | undefined>(
      (acc, c) => (!acc || cadenceRank(c.status) > cadenceRank(acc.status) ? c : acc),
      undefined,
    );
    matched = {
      prospectId: prospect.id,
      name: prospect.name,
      company: prospect.company,
      playName: best?.play_name ?? prospect.source,
    };
  }

  // Research before drafting: free tiers always, paid tier only for unknown
  // senders. Research failing must degrade the draft, never block it.
  let context: Awaited<ReturnType<typeof gatherReplyContext>> = {
    dossier: null,
    threadSent: [],
    priorInbound: [],
    costUsd: 0,
    researched: false,
  };
  try {
    context = await gatherReplyContext({
      fromEmail,
      prospectId: matched?.prospectId ?? null,
      threadKey:
        typeof body.id === "string" && body.id.length > 0
          ? inboxThreadKey({ threadId: body.threadId ?? null, id: body.id })
          : null,
      excludeId: typeof body.id === "string" ? body.id : null,
      // Never pay to research an autoresponder or an unsubscribe — there is
      // no human on the other end to ground a draft in.
      skipPaid: classifyReply({ subject, body: inboundBody }) !== "human",
    });
  } catch (err) {
    logEvent(
      "inbox.reply.research_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  }

  try {
    const draft = await draftInboxReply({
      fromEmail,
      subject,
      body: inboundBody,
      matched,
      dossier: context.dossier,
      threadSent: context.threadSent,
      priorInbound: context.priorInbound,
    });
    const out: InboxDraftReplyResult = {
      body: draft.body,
      costUsd: context.costUsd,
      researched: context.researched,
    };
    return jsonResponse(out, 200, req);
  } catch (err) {
    const message = (err as Error)?.message ?? "draft failed";
    logEvent("inbox.reply.draft_failed", { message_120: message.slice(0, 120) }, "warn");
    return jsonResponse({ error: message }, 400, req);
  }
}

/**
 * Persist the in-progress reply draft for a thread (debounced auto-save).
 * Upsert-by-thread-key so typing overwrites.
 */
export async function saveDraftRoute(req: Request): Promise<Response> {
  let body: Partial<InboxSaveDraftRequest>;
  try {
    body = (await req.json()) as Partial<InboxSaveDraftRequest>;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const threadKey = (body.threadKey ?? "").trim();
  const inboundEmailId = (body.inboundEmailId ?? "").trim();
  const toEmail = (body.toEmail ?? "").trim();
  if (!threadKey || !inboundEmailId || !toEmail) {
    return jsonResponse({ error: "threadKey, inboundEmailId and toEmail are required" }, 400, req);
  }

  const ledger = getLedger();
  // An emptied composer clears the draft so a refresh can't resurrect it.
  if ((body.body ?? "").trim() === "") {
    ledger.clearInboxDraft(threadKey);
  } else {
    ledger.upsertInboxDraft({
      threadKey,
      inboundEmailId,
      toEmail,
      subject: (body.subject ?? "").trim(),
      identityId: body.identityId ?? null,
      body: body.body ?? "",
    });
  }
  const out: InboxSaveDraftResult = { saved: true };
  return jsonResponse(out, 200, req);
}

/**
 * Send a (possibly founder-edited) reply from the identity whose mailbox
 * received the inbound email. Gmail sources thread properly; oneshot sources
 * are a best-effort fresh send (the platform has no threading API).
 */
export async function sendReplyRoute(req: Request): Promise<Response> {
  if (isDraining()) {
    return jsonResponse({ error: "server restarting — retry in a moment" }, 503, req);
  }
  let body: Partial<InboxSendReplyRequest>;
  try {
    body = (await req.json()) as Partial<InboxSendReplyRequest>;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const to = (body.to ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const replyBody = (body.body ?? "").trim();
  const identityId = (body.identityId ?? "").trim();
  const threadKey = (body.threadKey ?? "").trim();
  if (!to || !subject || !replyBody || !identityId || !threadKey) {
    return jsonResponse(
      { error: "to, subject, body, identityId and threadKey are required" },
      400,
      req,
    );
  }

  try {
    const { result } = await trackSend(() =>
      replyEmail(
        {
          identityId,
          to,
          subject,
          body: replyBody,
          ...(body.threadId ? { threadId: body.threadId } : {}),
          ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}),
          ...(body.replyToEmailId ? { replyToEmailId: body.replyToEmailId } : {}),
        },
        { playName: "inbox-reply", memo: `manual inbox reply to ${to}` },
      ),
    );
    // Persist the sent reply (append to thread history, clear the draft).
    const ledger = getLedger();
    ledger.recordInboxSent({
      threadKey,
      toEmail: to,
      subject,
      body: replyBody,
      identityId,
      requestId: result.request_id ?? null,
    });
    // Answering someone is proof they replied — the human is the detector of
    // last resort when the background poll misses. Idempotent, and never
    // allowed to fail a send that already happened.
    try {
      const prospect = ledger.findProspectByEmail(to);
      if (prospect) ledger.recordProspectReply(prospect.id, { subject });
    } catch (err) {
      logEvent(
        "inbox.reply.record_failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }
    logEvent("inbox.reply.sent", { to_domain: to.split("@")[1] ?? "", identity: identityId });
    const out: InboxSendReplyResult = {
      sent: true,
      id: result.request_id ?? "",
      costUsd: result.cost ?? 0,
    };
    return jsonResponse(out, 200, req);
  } catch (err) {
    const message = (err as Error)?.message ?? "send failed";
    logEvent("inbox.reply.send_failed", { message_120: message.slice(0, 120) }, "warn");
    return jsonResponse({ error: message }, 400, req);
  }
}
