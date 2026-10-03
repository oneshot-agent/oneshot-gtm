import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { parseBounce } from "./gmail.ts";
import { getLedger, type Ledger } from "./ledger.ts";
import { classifyReply } from "./reply-classify.ts";
import { parallelMap } from "./parallel.ts";
import {
  mailboxConnection,
  resetMailboxConnections,
  smartleadMailboxIdentities,
  type MailboxConnection,
} from "./mailbox-config.ts";
import {
  mailboxHash,
  type MailboxMessage,
  type MailboxHealth,
  type MailboxCheckpoint,
} from "./mailbox-store.ts";
import { outboundMessageId, type OutboundSend } from "./ledger-outbound.ts";
import { currentWorkspaceName } from "./shared-db.ts";
import type { AnnotatedInboxListResult, BounceListResult } from "./oneshot.ts";

export type { MailboxMessage, MailboxHealth } from "./mailbox-store.ts";
const DAY = 86_400_000;
const syncs = new Map<string, { started: number; pending: Promise<void> | null }>();
const reclassifiedStores = new WeakSet<object>();

/** Adapt a parsed mailbox message to the shared delivery-failure parser. */
function parseMailboxBounces(from: string, subject: string, body: string, deliveryStatus?: Buffer) {
  return parseBounce({
    id: "",
    threadId: "",
    internalDate: "0",
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") } },
        ...(deliveryStatus
          ? [
              {
                mimeType: "message/delivery-status",
                body: { data: deliveryStatus.toString("base64url") },
              },
            ]
          : []),
      ],
    },
  });
}

/** List delivery failures captured from active Smartlead mailboxes. */
export function listMailboxBounces(opts?: { since?: string }): BounceListResult {
  const identities = new Set(smartleadMailboxIdentities().map((i) => i.id));
  if (!identities.size) return { bounces: [], failedSources: [] };
  const ledger = getLedger();
  const bounces = ledger.mailboxes
    .bounceCandidates(opts?.since)
    .filter((m) => identities.has(m.identityId))
    .flatMap((m) => {
      const parsed = m.bounces ?? parseMailboxBounces(m.from, m.subject, m.body);
      if (m.bounces == null) ledger.mailboxes.reclassify(m, m.kind, parsed);
      return (
        parsed
          // Smartlead warmup shares the mailbox but is not workspace outreach.
          .filter((b) => ledger.hasPriorEmailSend(b.recipient))
          .map((b) => ({
            recipient: b.recipient,
            kind: b.kind,
            statusCode: b.statusCode,
            diagnostic: b.diagnostic,
            messageId: m.id,
            identityId: m.identityId,
            bouncedAt: m.at,
          }))
      );
    });
  return {
    bounces,
    failedSources: mailboxHealth()
      .filter((h) => h.status !== "connected" || h.backfillRemaining)
      .map((h) => h.identityId),
  };
}

/** Create a bounded, non-logging IMAP client for a mailbox connection. */
export function mailboxClient(connection: MailboxConnection): ImapFlow {
  const c = new ImapFlow({
    host: connection.imap.host,
    port: connection.imap.port,
    secure: connection.imap.secure,
    doSTARTTLS: connection.imap.secure ? undefined : true,
    auth: { user: connection.imap.user, pass: connection.imap.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableAutoIdle: true,
  });
  // Socket errors are reported through the active operation. Never log protocol data.
  c.on("error", () => {});
  return c;
}

/** Create a bounded, non-logging SMTP transport for a mailbox connection. */
function smtpTransport(connection: MailboxConnection) {
  return nodemailer.createTransport({
    host: connection.smtp.host,
    port: connection.smtp.port,
    secure: connection.smtp.secure,
    requireTLS: !connection.smtp.secure,
    auth: { user: connection.smtp.user, pass: connection.smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** Verify that both IMAP inbox access and SMTP authentication succeed. */
export async function verifyMailboxConnection(connection: MailboxConnection): Promise<void> {
  const imap = mailboxClient(connection);
  const smtp = smtpTransport(connection);
  try {
    await imap.connect();
    await imap.mailboxOpen("INBOX", { readOnly: true });
    await smtp.verify();
  } catch {
    throw new Error(
      "Mailbox login failed. Check IMAP/SMTP credentials, TLS settings, and account access.",
    );
  } finally {
    imap.close();
    smtp.close();
  }
}

/** Select the minimal useful set of readable folders for mailbox sync. */
export function mailboxFolders(folders: ListResponse[]): ListResponse[] {
  const selectable = folders.filter((f) => !f.flags.has("\\Noselect"));
  const all = selectable.find((f) => f.specialUse === "\\All");
  const sent = selectable.find((f) => f.specialUse === "\\Sent");
  const inbox = selectable.find((f) => f.path.toUpperCase() === "INBOX");
  const spam = selectable.find((f) => f.specialUse === "\\Junk");
  return [
    ...new Map(
      (all ? [all, spam] : [sent, inbox, spam])
        .filter((f): f is ListResponse => Boolean(f))
        .map((f) => [f.path, f]),
    ).values(),
  ];
}

/** Parse a raw provider message into the workspace's normalized mailbox record. */
export async function parseMailboxMessage(
  raw: Buffer,
  meta: { identityId: string; address: string; fallbackId: string; threadId?: string; at?: Date },
  ledger: Ledger,
): Promise<MailboxMessage> {
  const parseOptions = { skipImageLinks: true, skipTextToHtml: true, keepDeliveryStatus: true };
  const parsed = await simpleParser(raw, parseOptions);
  const from = parsed.from?.value[0]?.address?.toLowerCase() ?? "";
  const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
    .flatMap((v) => v.value.map((a) => a.address?.toLowerCase() ?? ""))
    .filter(Boolean);
  const messageId = parsed.messageId ?? null;
  const references = [
    ...new Set([
      ...(Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : []),
      ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ]),
  ];
  const direction = from === meta.address.toLowerCase() ? "outbound" : "inbound";
  const parents = references
    .map((id) => ledger.mailboxes.byMessageId(meta.identityId, id))
    .filter((m): m is MailboxMessage => Boolean(m));
  const root = references[0] ?? messageId ?? meta.fallbackId;
  const child = messageId ? ledger.mailboxes.referencing(meta.identityId, messageId) : null;
  const threadKey = meta.threadId
    ? `mailbox:${meta.identityId}:${mailboxHash(`gmail:${meta.threadId}`)}`
    : (parents[0]?.threadKey ??
      child?.threadKey ??
      `mailbox:${meta.identityId}:${mailboxHash(root)}`);
  const peer = direction === "inbound" ? from : to.find((a) => a !== meta.address.toLowerCase());
  const prospect = peer ? ledger.findProspectByEmail(peer) : null;
  const body = parsed.text?.trim() ?? "";
  const bounces = parseMailboxBounces(
    from,
    parsed.subject ?? "",
    body,
    parsed.attachments.find((a) => a.contentType === "message/delivery-status")?.content,
  );
  const autoSubmitted = String(parsed.headers.get("auto-submitted") ?? "");
  const auto = Boolean(autoSubmitted && autoSubmitted.toLowerCase() !== "no");
  return {
    id: `mailbox:${meta.identityId}:${mailboxHash(messageId ?? meta.fallbackId)}`,
    identityId: meta.identityId,
    threadKey,
    messageId,
    references,
    gmailThreadId: meta.threadId ?? null,
    from,
    to,
    replyTo: parsed.replyTo?.value[0]?.address?.toLowerCase() ?? null,
    subject: parsed.subject ?? "",
    body,
    at: (
      meta.at ?? (parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date : new Date())
    ).toISOString(),
    direction,
    kind: bounces.length
      ? "auto"
      : classifyReply({ subject: parsed.subject, body, autoSubmitted: auto }),
    autoSubmitted: bounces.length ? "auto-generated" : auto ? autoSubmitted : null,
    bounces,
    prospectId: parents.find((m) => m.prospectId != null)?.prospectId ?? prospect?.id ?? null,
  };
}

/** Fetch and persist a bounded batch of provider messages. */
async function capture(
  client: ImapFlow,
  uids: number[],
  identityId: string,
  address: string,
  folder: string,
  validity: string,
  ledger: Ledger,
): Promise<void> {
  for (let i = 0; i < uids.length; i += 20) {
    const batch = await client.fetchAll(
      uids.slice(i, i + 20),
      { uid: true, source: true, internalDate: true, threadId: true },
      { uid: true },
    );
    for (const m of batch) {
      if (!m.source) throw new Error("Mailbox returned a message without its body.");
      const message = await parseMailboxMessage(
        m.source,
        {
          identityId,
          address,
          fallbackId: `${folder}:${validity}:${m.uid}`,
          threadId: m.threadId,
          at: m.internalDate instanceof Date ? m.internalDate : undefined,
        },
        ledger,
      );
      ledger.mailboxes.put(message);
    }
  }
}

/** Resume incremental folder sync and reconcile sends for one identity. */
async function syncIdentity(identityId: string, address: string, ledger: Ledger): Promise<void> {
  const store = ledger.mailboxes;
  const prior = store.state<MailboxHealth>(`health:${identityId}`);
  const health: MailboxHealth = {
    identityId,
    address,
    lastSyncAt: prior?.lastSyncAt ?? null,
    status: "syncing",
    error: null,
    backfillRemaining: false,
    messages: prior?.messages ?? 0,
  };
  store.setState(`health:${identityId}`, health);
  let client: ImapFlow | null = null;
  try {
    const connection = await mailboxConnection(identityId);
    client = mailboxClient(connection);
    await client.connect();
    const folders = mailboxFolders(await client.list());
    if (!folders.length) throw new Error("No readable inbox folder found.");
    const oldest = store.oldestOutreach();
    const initialSince = new Date(
      Math.min(Date.now() - 30 * DAY, oldest ? new Date(oldest).getTime() : Infinity),
    ).toISOString();
    for (const folder of folders) {
      // Re-read identity configuration before each folder, so a removal takes effect mid-sync.
      if (!smartleadMailboxIdentities().some((i) => i.id === identityId)) return;
      const box = await client.mailboxOpen(folder.path, { readOnly: true });
      const validity = String(box.uidValidity);
      const key = `checkpoint:${identityId}:${folder.path}`;
      const saved = store.state<MailboxCheckpoint>(key);
      const cp =
        saved?.uidValidity === validity
          ? saved
          : { uidValidity: validity, lastUid: 0, since: initialSince, complete: false };
      const found = await client.search(
        cp.lastUid ? { uid: `${cp.lastUid + 1}:*` } : { since: new Date(cp.since) },
        { uid: true },
      );
      // IMAP n:* can return the last UID even when n is beyond it.
      const uids = (found || []).filter((uid) => uid > cp.lastUid).toSorted((a, b) => a - b);
      const page = uids.slice(0, 100);
      // Backfill walks forward for resumable checkpoints, but fresh replies
      // must not wait behind weeks of warmup mail. Sweep the newest tail too;
      // its IDs deduplicate when the historical cursor catches up.
      if (uids.length > page.length) {
        await capture(client, uids.slice(-25), identityId, address, folder.path, validity, ledger);
      }
      await capture(client, page, identityId, address, folder.path, validity, ledger);
      cp.lastUid = page.at(-1) ?? cp.lastUid;
      cp.complete = page.length === uids.length;
      store.setState(key, cp);
      health.backfillRemaining ||= !cp.complete;
    }
    // Sent copies are authoritative evidence for a crashed/timed-out reply.
    for (const send of ledger.outboundSends.unconfirmedReplies(identityId)) {
      if (send.messageId && store.byMessageId(identityId, send.messageId)) {
        ledger.outboundSends.mark(send.key, "confirmed", { observed: 1 });
        if (send.threadKey) ledger.clearInboxDraft(send.threadKey);
      }
    }
    health.status = "connected";
    health.lastSyncAt = new Date().toISOString();
    health.messages = store.all().filter((m) => m.identityId === identityId).length;
  } catch (err) {
    resetMailboxConnections();
    health.status = "error";
    // Connection library errors may include credentials or protocol responses.
    health.error =
      err instanceof Error &&
      /^(Smartlead|Direct mailbox|This mailbox|No readable)/.test(err.message)
        ? err.message
        : "Mailbox sync failed. Check the connection settings and retry.";
  } finally {
    client?.close();
    store.setState(`health:${identityId}`, health);
  }
}

/** Shared by the background poll and all inbox requests in this workspace process. */
export async function syncSmartleadMailboxes(force = false): Promise<void> {
  const ledger = getLedger();
  const identities = smartleadMailboxIdentities();
  if (!reclassifiedStores.has(ledger.mailboxes)) {
    const active = new Set(identities.map((i) => i.id));
    for (const m of ledger.mailboxes.all()) {
      if (m.direction === "inbound" && active.has(m.identityId)) {
        const bounces = m.bounces ?? parseMailboxBounces(m.from, m.subject, m.body);
        ledger.mailboxes.reclassify(
          m,
          bounces.length
            ? "auto"
            : classifyReply({
                subject: m.subject,
                body: m.body,
                autoSubmitted: Boolean(m.autoSubmitted),
              }),
          bounces,
        );
      }
    }
    reclassifiedStores.add(ledger.mailboxes);
  }
  await parallelMap(identities, 3, async (identity) => {
    const previous = syncs.get(identity.id);
    if (previous?.pending) return previous.pending;
    if (!force && previous && Date.now() - previous.started < 60_000) return;
    const entry = { started: Date.now(), pending: null as Promise<void> | null };
    entry.pending = syncIdentity(identity.id, identity.address ?? "", ledger).finally(() => {
      entry.pending = null;
    });
    syncs.set(identity.id, entry);
    return entry.pending;
  });
}

/** Return persisted connection and sync health for active mailbox identities. */
export function mailboxHealth(): MailboxHealth[] {
  const store = getLedger().mailboxes;
  return smartleadMailboxIdentities().map(
    (i) =>
      store.state<MailboxHealth>(`health:${i.id}`) ?? {
        identityId: i.id,
        address: i.address ?? "",
        lastSyncAt: null,
        status: "disconnected",
        error: null,
        backfillRemaining: true,
        messages: 0,
      },
  );
}

/** Sync and list one identity's normalized inbound mailbox window. */
export async function listMailboxInbox(
  identityId: string,
  opts?: { since?: string; until?: string; limit?: number },
): Promise<AnnotatedInboxListResult> {
  await syncSmartleadMailboxes();
  const ledger = getLedger();
  const health = mailboxHealth().find((h) => h.identityId === identityId);
  const messages = ledger.mailboxes.inbound(identityId, opts?.since, opts?.until);
  const selected = messages.slice(0, opts?.limit ?? 200);
  return {
    agent_id: identityId,
    emails: selected.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to[0] ?? "",
      subject: m.subject,
      body: m.body,
      received_at: m.at,
      thread_id: m.threadKey,
      message_id: m.messageId ?? undefined,
      source_identity_id: m.identityId,
      auto_submitted: Boolean(m.autoSubmitted),
      matched_prospect_id: m.prospectId ?? undefined,
    })),
    count: selected.length,
    has_more: selected.length < messages.length,
    ...(health?.status !== "connected" || health.backfillRemaining
      ? { failed_sources: [identityId] }
      : {}),
  };
}

/** Import provider history for a thread until its resumable scan completes. */
export async function hydrateMailboxThread(threadKey: string): Promise<void> {
  const ledger = getLedger();
  const store = ledger.mailboxes;
  if (store.threadState(threadKey).historyComplete) return;
  const messages = store.thread(threadKey);
  const seed = messages.find((m) => m.direction === "inbound") ?? messages[0];
  if (!seed) throw new Error("conversation not found");
  const connection = await mailboxConnection(seed.identityId);
  const client = mailboxClient(connection);
  try {
    await client.connect();
    let complete = true;
    for (const folder of mailboxFolders(await client.list())) {
      const box = await client.mailboxOpen(folder.path, { readOnly: true });
      const peer = seed.direction === "inbound" ? seed.from : seed.to[0];
      const found = await client.search(
        seed.gmailThreadId
          ? { threadId: seed.gmailThreadId }
          : { or: [{ from: peer }, { to: peer }] },
        { uid: true },
      );
      const uids = found || [];
      // Cache progress so long histories can be resumed without refetching the same page.
      const progressKey = `history:${threadKey}:${folder.path}:${box.uidValidity}`;
      const done = new Set(store.state<number[]>(progressKey) ?? []);
      const remaining = uids.filter((uid) => !done.has(uid));
      const page = remaining.slice(0, 200);
      await capture(
        client,
        page,
        seed.identityId,
        connection.address,
        folder.path,
        String(box.uidValidity),
        ledger,
      );
      store.setState(progressKey, [...done, ...page]);
      complete &&= remaining.length <= page.length;
    }
    if (complete) store.markHistoryComplete(threadKey);
  } catch {
    throw new Error(
      "Could not load complete mailbox history. Your saved messages are still available; retry to continue.",
    );
  } finally {
    client.close();
  }
}

/** Build a threaded outbound mailbox record from a stored inbound message. */
export function mailboxReplyMessage(
  inbound: MailboxMessage,
  address: string,
  body: string,
  opts: { messageId?: string; at?: string; subject?: string; references?: string[] } = {},
): MailboxMessage {
  if (!inbound.messageId)
    throw new Error("This message has no Message-ID; a threaded reply cannot be sent safely.");
  const messageId = opts.messageId ?? `<${randomUUID()}@${address.split("@")[1]}>`;
  return {
    ...inbound,
    id: `mailbox:${inbound.identityId}:${mailboxHash(messageId)}`,
    messageId,
    references: opts.references ?? [...new Set([...inbound.references, inbound.messageId])],
    from: address,
    to: [inbound.replyTo || inbound.from],
    replyTo: null,
    subject:
      opts.subject ?? (/^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`),
    body,
    at: opts.at ?? new Date().toISOString(),
    direction: "outbound",
    kind: "human",
    autoSubmitted: null,
  };
}

/**
 * An SMTP submission that did not complete. `definite` = the server never
 * received the message (connect/auth failure, or an explicit 4xx/5xx), so a
 * retry is safe. Otherwise the outcome is unknown: the connection dropped
 * after DATA was handed over, and the message may already be out.
 */
export class MailboxSubmitError extends Error {
  readonly definite: boolean;
  constructor(message: string, definite: boolean) {
    super(message);
    this.name = "MailboxSubmitError";
    this.definite = definite;
  }
}

/** One message to submit over a mailbox's SMTP connection. */
export interface MailboxMail {
  from: string | { name: string; address: string };
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Pre-set Message-ID, so the same email keeps one id on every attempt. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  date: Date;
}

/**
 * Build the MIME once and submit it over SMTP once. Shared by threaded
 * replies and new sends. Never retries: the caller decides, from
 * `MailboxSubmitError.definite`, whether a retry is safe. Transport errors
 * can carry credentials, so none are attached as causes.
 */
async function submitMailboxMail(
  connection: MailboxConnection,
  mail: MailboxMail,
): Promise<Buffer> {
  const smtp = smtpTransport(connection);
  let submitted = false;
  try {
    // Authentication/connect failures are definitive: no DATA was submitted.
    await smtp.verify();
    const mime = await nodemailer
      .createTransport({ streamTransport: true, buffer: true, newline: "windows" })
      .sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        messageId: mail.messageId,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references?.length ? { references: mail.references } : {}),
        date: mail.date,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    submitted = true;
    const envelopeFrom = typeof mail.from === "string" ? mail.from : mail.from.address;
    const accepted = await smtp.sendMail({
      envelope: { from: envelopeFrom, to: mail.to },
      raw: mime.message,
    });
    if (!accepted.accepted?.length) {
      // SMTP explicitly accepted no recipients; retry is safe.
      throw new MailboxSubmitError("SMTP did not accept the message.", true);
    }
    return mime.message as Buffer;
  } catch (err) {
    if (err instanceof MailboxSubmitError) throw err;
    // An explicit SMTP rejection is definitive; a disconnect after DATA is not.
    const code = (err as { responseCode?: number }).responseCode;
    const definite = !submitted || (code != null && code >= 400 && code < 600);
    // Transport exceptions can contain authentication details; do not attach them as causes.
    throw new MailboxSubmitError(
      definite ? "SMTP rejected the message." : "SMTP outcome unknown.",
      definite,
    );
  } finally {
    smtp.close();
  }
}

/**
 * Gmail stores SMTP submissions in Sent by itself; other IMAP providers need
 * an explicit copy. Checks by Message-ID first so a re-run never appends
 * twice. Returns false when the copy could not be saved. That never turns
 * into a resend: the message itself already went out.
 */
/**
 * Whether the SMTP server files its own Sent copy of what it accepts (Gmail
 * does). Elsewhere the IMAP append after submission is the only copy, so an
 * interrupted submission leaves nothing in Sent to prove either way.
 */
export function serverKeepsSentCopy(connection: Pick<MailboxConnection, "smtp">): boolean {
  return /gmail\.com$/i.test(connection.smtp.host);
}

async function saveSentCopy(
  connection: MailboxConnection,
  mime: Buffer,
  messageId: string,
  date: Date,
): Promise<boolean> {
  if (serverKeepsSentCopy(connection)) return true;
  const client = mailboxClient(connection);
  try {
    await client.connect();
    const sent = (await client.list()).find((f) => f.specialUse === "\\Sent");
    if (sent) {
      await client.mailboxOpen(sent.path, { readOnly: true });
      const existing = await client.search({ header: { "message-id": messageId } }, { uid: true });
      if (!existing || !existing.length) await client.append(sent.path, mime, ["\\Seen"], date);
    }
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/** The outbound_sends key of one mailbox reply: one per client send request. */
export function replySendKey(requestId: string): string {
  return `gtm:${currentWorkspaceName()}:reply:${requestId}`;
}

/** The outbound record a stored reply send went out as (for a replay). */
function replyFromSend(
  inbound: MailboxMessage,
  address: string,
  send: OutboundSend,
): MailboxMessage {
  return mailboxReplyMessage(inbound, address, send.body, {
    ...(send.messageId ? { messageId: send.messageId } : {}),
    at: send.dateHeader ?? send.firstAttemptAt,
    subject: send.subject,
    references: send.references,
  });
}

/**
 * Send a threaded reply to a stored inbound message. Uses only stored routing
 * metadata, never client-supplied From/To/thread headers. The reply is
 * claimed in `outbound_sends` under `replySendKey(requestId)` before SMTP
 * runs, with a Message-ID derived from that key and its full content, so:
 * - the same request id with another body is refused;
 * - the same request id after a send replays it (nothing is sent again);
 * - a pending or unconfirmed reply to the same inbound blocks a new one until
 *   it is reconciled against Sent (mailbox sync or the confirm sweep);
 * - only a definite failure frees the inbound for a new request.
 * A refused click writes no row.
 */
export async function sendMailboxReply(
  inboundId: string,
  body: string,
  requestId: string,
): Promise<MailboxMessage> {
  const ledger = getLedger();
  const store = ledger.mailboxes;
  const sends = ledger.outboundSends;
  const inbound = store.get(inboundId);
  if (!inbound || inbound.direction !== "inbound")
    throw new Error("Inbound message not found in this workspace.");
  const connection = await mailboxConnection(inbound.identityId);
  const key = replySendKey(requestId);
  const settled = async (prior: OutboundSend): Promise<MailboxMessage> => {
    if (prior.inboundId !== inboundId || prior.body !== body)
      throw new Error("Send request does not match the saved attempt.");
    if (prior.status === "submitted" || prior.status === "confirmed")
      return replyFromSend(inbound, connection.address, prior);
    if (prior.status === "failed")
      throw new Error("Previous send failed. Start a new send attempt.");
    if (prior.status === "not_found")
      throw new Error(
        "Delivery is not confirmed. Check the recipient's thread before sending again.",
      );
    await syncSmartleadMailboxes(true);
    const latest = sends.get(key);
    if (latest?.status === "confirmed" || latest?.status === "submitted")
      return replyFromSend(inbound, connection.address, latest);
    throw new Error(
      "Previous send has an unknown outcome. It will be reconciled against Sent mail; do not resend it yet.",
    );
  };
  const prior = sends.get(key);
  if (prior) return settled(prior);
  const messageId = outboundMessageId(key, connection.address);
  const message = mailboxReplyMessage(inbound, connection.address, body, { messageId });
  const claim = sends.claimReply({
    key,
    identityId: inbound.identityId,
    transport: "smtp",
    recipient: (message.to[0] ?? "").trim().toLowerCase(),
    subject: message.subject,
    body,
    messageId,
    sentEvidence: serverKeepsSentCopy(connection),
    inboundId,
    threadKey: message.threadKey,
    inReplyTo: inbound.messageId!,
    references: message.references,
    dateHeader: message.at,
  });
  if (claim.verdict === "exists") return settled(claim.send);
  if (claim.verdict === "busy")
    throw new Error(
      "A previous send is still being reconciled. Refresh the thread before retrying.",
    );
  try {
    const date = new Date(message.at);
    const mime = await submitMailboxMail(connection, {
      from: connection.address,
      to: message.to,
      subject: message.subject,
      text: body,
      messageId,
      inReplyTo: inbound.messageId!,
      references: message.references,
      date,
    });
    store.put(message);
    sends.mark(key, "submitted", { messageId });
    ledger.clearInboxDraft(message.threadKey);
    if (!(await saveSentCopy(connection, mime, messageId, date))) {
      // Submission succeeded. A Sent-copy failure must never turn into a retry of DATA.
      store.setState(`sent-copy:${requestId}`, {
        messageId,
        error: "Reply sent; mailbox Sent copy could not be saved.",
      });
    }
    return message;
  } catch (err) {
    const definite = err instanceof MailboxSubmitError ? err.definite : true;
    sends.mark(key, definite ? "failed" : "uncertain", {
      error: definite
        ? "SMTP rejected the reply. Check your connection and retry."
        : "Send outcome unknown; checking Sent mail before retry.",
    });
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(
      definite
        ? "Reply was not sent. Check mailbox settings and retry."
        : "Send outcome unknown. Refresh to reconcile Sent mail before retrying.",
    );
  }
}

/** A new (non-reply) email sent straight through a mailbox's own SMTP. */
export interface MailboxInitialInput {
  identityId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  fromName?: string | null;
  /** Deterministic per intended email (see `outboundMessageId`). */
  messageId: string;
  /** Already resolved by the caller; looked up from `identityId` otherwise. */
  connection?: MailboxConnection;
}

/**
 * Send one new email through a mailbox identity's SMTP. The caller owns
 * idempotency: it claims the semantic key in `outbound_sends` first and
 * passes the same Message-ID on every attempt. Throws `MailboxSubmitError`
 * (definite vs uncertain) on failure.
 */
export async function sendMailboxInitial(
  input: MailboxInitialInput,
): Promise<{ messageId: string; from: string; sentCopySaved: boolean }> {
  const connection = input.connection ?? (await mailboxConnection(input.identityId));
  const date = new Date();
  const name = input.fromName?.trim();
  const mime = await submitMailboxMail(connection, {
    from: name ? { name, address: connection.address } : connection.address,
    to: [input.to],
    subject: input.subject,
    text: input.text,
    html: input.html,
    messageId: input.messageId,
    date,
  });
  const sentCopySaved = await saveSentCopy(connection, mime, input.messageId, date);
  return { messageId: input.messageId, from: connection.address, sentCopySaved };
}
