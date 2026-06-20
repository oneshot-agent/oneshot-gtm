import {
  getGmailProfile,
  getLedger,
  isDraining,
  listInbox,
  loadConfig,
  logEvent,
  replyEmail,
  resolveIdentities,
  trackSend,
} from "@oneshot-gtm/core";
import { draftInboxReply } from "@oneshot-gtm/plays";
import {
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

/** "Jane Doe <jane@x.com>" → "jane@x.com"; bare addresses pass through. */
function normalizeFrom(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? (m[1] ?? raw) : raw).trim().toLowerCase();
}

/**
 * Cadence-status priority for "which play represents this prospect's reply":
 * a `replied` cadence wins, then `active`, then anything else. Shared by the
 * list route (badge) and the draft route (prior-email context) so the play
 * shown and the play whose history feeds the LLM never diverge for a prospect
 * enrolled in several plays. Ties keep the first row seen.
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
  try {
    // Fetch a wide window (not just the newest handful): mailboxes fill with
    // newsletters/bounces/DMARC noise, and matching only runs over what's
    // fetched — too small a window buries a genuine prospect reply (and its
    // match) below the noise. The UI defaults to the `matched` filter to surface
    // those; this gives it enough history to find them.
    const result = await listInbox({ limit: 200 });
    emails = result.emails;
  } catch (err) {
    logEvent(
      "inbox.list_failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    const out: InboxResult = { replies: [], hasMore: false, error: "couldn't reach the inbox" };
    return jsonResponse(out, 200, req);
  }

  // Cadence-backed prospects (multi-touch plays) carry play + status + name/co
  // in one JOIN. Index by normalized email; prefer a `replied`/`active` cadence
  // when a prospect has several.
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

  // Identity provider per id — the UI needs to know whether a reply will be a
  // threaded Gmail send or a best-effort (paid, unthreaded) OneShot send.
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

  // Drop mail from the founder's own sending domain — the mailbox accumulates
  // the agent's own sends + platform/system test mail (agent@/info@<domain>),
  // which are never genuine prospect replies. Then newest-first.
  const selfDomain = (cfg.sendingDomain ?? "").trim().toLowerCase();
  // Gmail self-sends: the Gmail query already excludes `from:me`, but
  // belt-and-braces against forwarded copies of the founder's own address.
  // Pool identities carry their address in config — no network call needed.
  // Only the legacy synthesized identity (no address field) needs a live
  // profile lookup, and that failing shouldn't break the replies page.
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

  const out: InboxResult = { replies: visible, hasMore: false };
  return jsonResponse(out, 200, req);
}

/**
 * Generate an LLM reply draft for an inbound email. The client sends the
 * email content it already has (re-fetching the live inbox here would add a
 * multi-second round-trip per draft). Prospect/play context is re-resolved
 * from the ledger by sender address — same matching as the list route.
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
  if (!fromEmail || !inboundBody) {
    return jsonResponse({ error: "fromEmail and body are required" }, 400, req);
  }

  const ledger = getLedger();
  const prospect = ledger.getProspectByEmail(fromEmail);
  let matched: Parameters<typeof draftInboxReply>[0]["matched"] = null;
  if (prospect) {
    // Same ranking as the list route's badge (cadenceRank) so the play whose
    // prior emails feed the draft matches the one the founder sees.
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

  try {
    const draft = await draftInboxReply({ fromEmail, subject, body: inboundBody, matched });
    const out: InboxDraftReplyResult = { body: draft.body };
    return jsonResponse(out, 200, req);
  } catch (err) {
    const message = (err as Error)?.message ?? "draft failed";
    logEvent("inbox.reply.draft_failed", { message_120: message.slice(0, 120) }, "warn");
    return jsonResponse({ error: message }, 400, req);
  }
}

/**
 * Persist the in-progress reply draft for a thread (debounced auto-save from
 * the composer). Distinct from `/api/inbox/draft-reply`, which only generates
 * an LLM draft and stores nothing. Upsert-by-thread-key so typing overwrites.
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
  // An emptied composer clears the persisted draft rather than storing a blank
  // one, so deleting all text and refreshing doesn't resurrect the old draft.
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
 * are a best-effort fresh send (no threading API — verified against the
 * platform's OpenAPI spec).
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
    // Persist the sent reply (append to thread history, clear the draft) so the
    // founder can see what they sent after a refresh.
    getLedger().recordInboxSent({
      threadKey,
      toEmail: to,
      subject,
      body: replyBody,
      identityId,
      requestId: result.request_id ?? null,
    });
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
