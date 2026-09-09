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
  sqliteToIso,
  trackSend,
  type ReplyKind,
  notifySlackBounceRecorded,
  notifySlackReplyReceived,
} from "@oneshot-gtm/core";
import { bodyCommitsTerms, draftInboxReply } from "@oneshot-gtm/plays";
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
  type InboxSteerRequest,
  type InboxSteerResult,
  type ReplyIntent,
  inboxThreadKey,
  POSITIVE_REPLY_INTENTS,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { gatherReplyContext } from "./_reply-research.ts";

/**
 * Classification of the inbound being answered: the persisted kind when the
 * email was captured (header-aware), else re-classified from its text.
 */
function inboundReplyKind(
  ledger: ReturnType<typeof getLedger>,
  prospectId: number | null,
  body: Partial<InboxDraftReplyRequest>,
  subject: string,
  inboundBody: string,
): ReplyKind {
  if (prospectId != null && typeof body.id === "string") {
    const stored = ledger.listInboxRepliesForProspect(prospectId).find((r) => r.id === body.id);
    if (stored?.kind) return stored.kind as ReplyKind;
  }
  return classifyReply({ subject, body: inboundBody });
}

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
/**
 * The live mailbox read, shared by every caller that lands inside the window:
 * the nav's alert dot and the /inbox page each poll once a minute and used to
 * fire two full fetches (list + every message body, across every Gmail
 * account) within the same second — enough, with the scheduler's own poll,
 * to trip Gmail's per-user-per-minute query-cost quota on all mailboxes at
 * once. One in-flight promise is handed to concurrent callers, and the result
 * is reused for `LIVE_INBOX_TTL_MS`; failures are never cached. Reads only —
 * the opportunistic capture below still runs per request against whatever
 * this returns.
 */
const LIVE_INBOX_TTL_MS = 30_000;
type LiveInbox = { emails: Awaited<ReturnType<typeof listInbox>>["emails"]; hasMore: boolean };
let liveInbox: { at: number; promise: Promise<LiveInbox> } | null = null;

/** Test-only: forget the shared live read between cases. */
export function _resetLiveInboxCache(): void {
  liveInbox = null;
}

function fetchLiveInbox(ledger: ReturnType<typeof getLedger>): Promise<LiveInbox> {
  const now = Date.now();
  if (liveInbox && now - liveInbox.at < LIVE_INBOX_TTL_MS) return liveInbox.promise;
  const promise = (async (): Promise<LiveInbox> => {
    // Wide window: matching only runs over what's fetched, and mailbox noise
    // would bury a genuine prospect reply in a small one.
    const result = await listInbox({ limit: 200 });
    let emails = result.emails;
    // Truthful truncation signal — the page must never present a clamped
    // window as the entire mailbox.
    const hasMore = result.has_more;
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
          emails = [...emails, ...extra].toSorted(
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
    return { emails, hasMore };
  })();
  liveInbox = { at: now, promise };
  promise.catch(() => {
    // A failed read must not be served to the next caller.
    if (liveInbox?.promise === promise) liveInbox = null;
  });
  return promise;
}

export async function listInboxRoute(req: Request): Promise<Response> {
  const ledger = getLedger();

  let emails: LiveInbox["emails"];
  let hasMore = false;
  try {
    const live = await fetchLiveInbox(ledger);
    emails = live.emails;
    hasMore = live.hasMore;
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
      conversations = buildConversations(
        ledger,
        cadenceIndex(ledger),
        ledger.getInboxThreads(),
        ledger.listLatestOutcomeRecordedAtByProspect(),
      );
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
  // Sentiment/intent per persisted reply id (issue #480) — set by the
  // background poll's triage call, read here for the badge. Absent/null =
  // not yet triaged.
  const intents = ledger.listInboxReplyIntents(emails.map((e) => e.id));

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
    const intent = intents.get(e.id);
    return {
      id: e.id,
      fromEmail,
      fromRaw: e.from,
      subject: e.subject,
      receivedAt: e.received_at,
      body: e.body ?? "",
      kind: classifyReply({ subject: e.subject, body: e.body, autoSubmitted: e.auto_submitted }),
      intent: (intent?.intent as ReplyIntent | null | undefined) ?? null,
      intentReason: intent?.intentReason ?? null,
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
  // above flows through here on first load. Best-effort. Classification
  // (issue #480/#558) is intentionally NOT done here — pollInboxReplies is
  // the one choke point that also classifies rows this capture inserted but
  // didn't triage (see _cadence.ts's isNewReply-or-untriaged check).
  try {
    for (const r of visible) {
      if (!r.matched) continue;
      const p = ledger.findProspectByEmail(r.fromEmail);
      if (!p) continue;
      const isNew = ledger.recordInboxReply({
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
      // Slack notification: fire-and-forget on first sight only, and only for
      // real human replies — same `kind === "human"` gate as the primary
      // detection path in _cadence.ts (autoresponders/unsubscribes are not
      // replies by this codebase's own definition and must not alert).
      if (isNew && r.kind === "human") {
        void notifySlackReplyReceived({
          from_email: r.fromEmail,
          subject: r.subject,
          play_name: r.matched.playName,
          kind: r.kind,
        });
      }
      // Dead-mailbox bounce alert: this opportunistic capture and the
      // scheduler's pollInboxReplies() both call recordInboxReply with the
      // same id (INSERT OR IGNORE), so `isNew` here is a first-sight claim
      // that can race the scheduler's own first-sight check in _cadence.ts
      // (issue #71 review finding — a GET /api/inbox hitting a dead-mailbox
      // autoresponder before the next scheduled poll would claim isNew here,
      // leaving the scheduler's poll to see isNew=false and skip its own
      // alert, silently dropping the bounce notification entirely). Mirror
      // _cadence.ts's gate exactly: only `auto_permanent` counts as a bounce
      // (`unsubscribe` is a do-not-contact, not a bounce) and fires only once
      // per email via the same isNew signal.
      if (isNew && r.kind === "auto_permanent") {
        void notifySlackBounceRecorded({
          recipient: r.fromEmail,
          kind: "auto_permanent",
          status_code: null,
        });
      }
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
    conversations = buildConversations(
      ledger,
      byEmail,
      threads,
      ledger.listLatestOutcomeRecordedAtByProspect(),
    );
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
  outcomeRecordedAtByProspect: Map<number, string>,
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
        intent: (r.intent as ReplyIntent | null) ?? null,
      });
    }
    for (const key of threadKeys) {
      for (const s of threads.get(key)?.sent ?? []) {
        items.push({ kind: "sent", at: s.sentAt, subject: null, body: s.body });
      }
    }
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const cadence = byEmail.get(prospect.email.trim().toLowerCase());
    const newestThread = threads.get(inbound.at(-1)!.thread_key) ?? null;
    const newestInbound = inbound.at(-1)!;
    // Round-2 correction (#480): a positive-intent inbound stays "awaiting
    // reply" until the founder answers it (any sent item on the thread after
    // it arrived) or records a deal outcome for this prospect after it arrived — otherwise
    // the nav dot lit by POSITIVE_REPLY_INTENTS never turns off.
    const positiveIntent =
      newestInbound.intent != null &&
      POSITIVE_REPLY_INTENTS.includes(newestInbound.intent as ReplyIntent);
    const repliedSince = (newestThread?.sent ?? []).some(
      (s) => s.sentAt > newestInbound.received_at,
    );
    const outcomeRecordedAt = outcomeRecordedAtByProspect.get(prospectId);
    const outcomeSince =
      outcomeRecordedAt != null &&
      Date.parse(sqliteToIso(outcomeRecordedAt)) > Date.parse(newestInbound.received_at);
    const awaitingReply = positiveIntent && !repliedSince && !outcomeSince;
    out.push({
      prospectId,
      name: prospect.name,
      company: prospect.company,
      email: prospect.email,
      playName: cadence?.playName ?? inbound.at(-1)?.play_name ?? prospect.source,
      cadenceStatus: cadence?.status ?? null,
      lastActivityAt: items.at(-1)?.at ?? inbound.at(-1)!.received_at,
      draftBody: newestThread?.draftBody ?? null,
      steer: newestThread?.steer ?? null,
      status: newestThread?.status ?? null,
      intent: (inbound.at(-1)?.intent as ReplyIntent | null) ?? null,
      awaitingReply,
      items,
    });
  }
  // Most recent activity first — the row order of the matched tab.
  return out.toSorted((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
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
  // angleJson still seeds from the matched prospect on this fallback path —
  // it's a free ledger field, not part of what research produces, so a
  // research failure must not also throw away a stored angle (finding
  // PRRT_kwDOSKzrBs6gZ7Qs).
  let context: Awaited<ReturnType<typeof gatherReplyContext>> = {
    dossier: null,
    angleJson: prospect?.angle_json ?? null,
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
      // no human on the other end to ground a draft in. Prefer the persisted
      // classification (it saw the Gmail headers at capture time); the text
      // fallback covers mail that was never captured.
      skipPaid:
        inboundReplyKind(ledger, matched?.prospectId ?? null, body, subject, inboundBody) !==
        "human",
    });
  } catch (err) {
    logEvent(
      "inbox.reply.research_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  }

  try {
    // Intent (issue #480) — persisted classification of the inbound being
    // answered, read the same way inboundReplyKind reads `kind`: prefer the
    // stored row (it's what the background poll actually classified), fall
    // back to null (unclassified) rather than re-triaging inline — triage is
    // an LLM call and the draft button is already paying for one.
    const intent =
      matched?.prospectId != null && typeof body.id === "string"
        ? (ledger.listInboxRepliesForProspect(matched.prospectId).find((r) => r.id === body.id)
            ?.intent ?? null)
        : null;
    const threadKey =
      typeof body.id === "string" && body.id.length > 0
        ? inboxThreadKey({ threadId: body.threadId ?? null, id: body.id })
        : null;
    const steer = threadKey ? (ledger.getInboxThreads().get(threadKey)?.steer ?? null) : null;
    const draft = await draftInboxReply({
      fromEmail,
      subject,
      body: inboundBody,
      matched,
      dossier: context.dossier,
      angleJson: context.angleJson,
      threadSent: context.threadSent,
      priorInbound: context.priorInbound,
      intent,
      steer,
    });
    const out: InboxDraftReplyResult = {
      body: draft.body,
      costUsd: context.costUsd,
      researched: context.researched,
      flags: draft.flags,
      needsDecision: draft.flags.includes("commits-terms"),
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
 * Upsert-by-thread-key so typing overwrites. `status` is recomputed here
 * from the body's own text (issue #480's `commits-terms` lint) — never
 * trusted from the client, so a founder can't accidentally (or a hostile
 * client can't deliberately) unlock Send by lying about it.
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
  const draftBody = body.body ?? "";
  let status: "needs_decision" | null = null;
  // An emptied composer clears the draft so a refresh can't resurrect it.
  if (draftBody.trim() === "") {
    ledger.clearInboxDraft(threadKey);
  } else {
    status = bodyCommitsTerms(draftBody) ? "needs_decision" : null;
    ledger.upsertInboxDraft({
      threadKey,
      inboundEmailId,
      toEmail,
      subject: (body.subject ?? "").trim(),
      identityId: body.identityId ?? null,
      body: draftBody,
      status,
    });
  }
  const out: InboxSaveDraftResult = { saved: true, status };
  return jsonResponse(out, 200, req);
}

/**
 * Persist a founder redraft instruction on a thread and generate a fresh
 * draft grounded in it (issue #480's steer box). Upserts the draft row first
 * (steer can arrive before any draft exists — e.g. the founder writes a
 * steer note before ever hitting "generate") so `setInboxDraftSteer`'s
 * UPDATE always has a row to land on.
 */
export async function steerRoute(req: Request): Promise<Response> {
  let body: Partial<InboxSteerRequest>;
  try {
    body = (await req.json()) as Partial<InboxSteerRequest>;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const fromEmail = (body.fromEmail ?? "").trim().toLowerCase();
  const subject = (body.subject ?? "").trim();
  const inboundBody = (body.body ?? "").trim();
  const threadKey = (body.threadKey ?? "").trim();
  const steer = (body.steer ?? "").trim();
  if (!fromEmail || !threadKey || !steer) {
    return jsonResponse({ error: "fromEmail, threadKey and steer are required" }, 400, req);
  }
  if (!inboundBody) {
    return jsonResponse({ error: "this email has no body to draft a reply from" }, 400, req);
  }

  const ledger = getLedger();
  const prospect = ledger.getProspectByEmail(fromEmail);
  let matched: Parameters<typeof draftInboxReply>[0]["matched"] = null;
  if (prospect) {
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

  // Persist the steer FIRST (issue #480: it's a standing instruction, not a
  // one-shot prompt — it must survive even if the redraft below fails).
  // upsertInboxDraft needs an inboundEmailId/toEmail/subject/body to write a
  // row; if none exists yet, seed it with the inbound context and an empty
  // body so setInboxDraftSteer's UPDATE has something to land on.
  const existing = ledger.getInboxThreads().get(threadKey);
  // A thread with only sent history still yields an entry (draftBody null),
  // so test the draft row itself — otherwise both UPDATEs below hit no rows.
  if (existing?.draftBody == null && existing?.steer == null) {
    ledger.upsertInboxDraft({
      threadKey,
      inboundEmailId: typeof body.id === "string" ? body.id : threadKey,
      toEmail: fromEmail,
      subject,
      identityId: null,
      body: "",
    });
  }
  ledger.setInboxDraftSteer(threadKey, steer);

  let context: Awaited<ReturnType<typeof gatherReplyContext>> = {
    dossier: null,
    angleJson: prospect?.angle_json ?? null,
    threadSent: [],
    priorInbound: [],
    costUsd: 0,
    researched: false,
  };
  try {
    context = await gatherReplyContext({
      fromEmail,
      prospectId: matched?.prospectId ?? null,
      threadKey,
      excludeId: typeof body.id === "string" ? body.id : null,
      skipPaid:
        inboundReplyKind(ledger, matched?.prospectId ?? null, body, subject, inboundBody) !==
        "human",
    });
  } catch (err) {
    logEvent(
      "inbox.reply.research_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  }

  try {
    const intent =
      matched?.prospectId != null && typeof body.id === "string"
        ? (ledger.listInboxRepliesForProspect(matched.prospectId).find((r) => r.id === body.id)
            ?.intent ?? null)
        : null;
    const draft = await draftInboxReply({
      fromEmail,
      subject,
      body: inboundBody,
      matched,
      dossier: context.dossier,
      angleJson: context.angleJson,
      threadSent: context.threadSent,
      priorInbound: context.priorInbound,
      intent,
      steer,
    });
    const needsDecision = draft.flags.includes("commits-terms");
    // Round-1 correction (#480): persist the generated body itself, not just
    // the steer instruction — the client's autosave effects only fire on a
    // body DIFF from the last SAVED value, and `onSuccess` sets that value
    // directly from this response without ever calling the save API, so
    // without this write the redraft displayed in the composer was never
    // durably stored and a refresh/collapse reverted to the prior draft.
    ledger.setInboxDraftBody(threadKey, draft.body, needsDecision ? "needs_decision" : null);
    const out: InboxSteerResult = {
      body: draft.body,
      costUsd: context.costUsd,
      researched: context.researched,
      flags: draft.flags,
      needsDecision,
    };
    return jsonResponse(out, 200, req);
  } catch (err) {
    const message = (err as Error)?.message ?? "draft failed";
    logEvent("inbox.reply.steer_draft_failed", { message_120: message.slice(0, 120) }, "warn");
    return jsonResponse({ error: message }, 400, req);
  }
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
  // Send gate (issue #480): `commits-terms` is the one lint flag that blocks
  // Send outright — checked on the TEXT BEING SENT, not a possibly-stale
  // persisted `status` (the debounced autosave can lag a fast edit-then-send).
  // The founder can still get past it: edit the commitment out, or steer a
  // redraft that doesn't carry it.
  if (bodyCommitsTerms(replyBody)) {
    return jsonResponse(
      {
        error:
          "this reply commits to something unauthorised (pricing, distribution, partnership terms, documentation placement, or similar) — edit it out or steer a redraft before sending",
      },
      409,
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
