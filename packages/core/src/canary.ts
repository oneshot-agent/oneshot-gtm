import { loadConfig } from "./config.ts";
import { logEvent } from "./events.ts";
import {
  findPlacedMessage,
  getGmailProfile,
  getSentMessageId,
  rfc822MsgIdQuery,
  sendGmailMessage,
  type AuthResults,
} from "./gmail.ts";
import { gmailAccountFor, resolveIdentities } from "./identities.ts";
import { getLedger } from "./ledger.ts";
import { toHtmlBody } from "./oneshot.ts";
import type { EmailIdentity, GmailPlacement } from "./types.ts";

/**
 * Inbox-placement canary: send a real message from one authorized mailbox to
 * another, then look up where the receiving account actually filed it.
 *
 * Bounce harvesting answers "was it refused?". This answers the question that
 * silently kills cold outreach: accepted, but into spam or a tab. There is no
 * API that reports this — the only source of truth is a mailbox you control on
 * the receiving side, which is why this needs TWO connected accounts. A message
 * sent to itself is never filtered, so a self-send would always read "inbox"
 * and mean nothing.
 *
 * Deliberately NOT wired into doctor or any sweep: it sends real mail. Repeated
 * canaries to the same address also train that mailbox's filter in your favour,
 * so the result drifts optimistic the more often you run it. Manual only.
 */

/** Give up waiting for the canary to show up in the receiving mailbox. */
const DEFAULT_DEADLINE_MS = 120_000;
const FIRST_POLL_DELAY_MS = 3_000;
const POLL_INTERVAL_MS = 5_000;

export interface CanaryOptions {
  /** Identity id to send from. Default: first Gmail identity in the pool. */
  fromIdentityId?: string;
  /** Identity id to receive. Default: first Gmail identity that isn't the sender. */
  toIdentityId?: string;
  /** Play whose most recent real email is replayed as the canary body. Default: newest of any play. */
  playName?: string;
  deadlineMs?: number;
  /** Test seam — polling clock. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CanaryResult {
  fromIdentity: string;
  fromAddress: string;
  toIdentity: string;
  toAddress: string;
  placement: GmailPlacement;
  labelIds: string[];
  auth: AuthResults;
  subject: string;
  /** Play whose copy was replayed, or null when no real send existed to borrow. */
  sourcePlay: string | null;
  /** True when both mailboxes share a domain — see `sameDomainWarning`. */
  sameDomain: boolean;
  latencyMs: number | null;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generic stand-in used only when the ledger holds no real sent email to
 * replay. Flagged as such in the result: spam filters judge CONTENT, so a
 * placement verdict on filler text says very little about the copy that
 * actually ships.
 */
function sampleCopy(): { subject: string; body: string } {
  const cfg = loadConfig();
  const product = cfg.productOneLiner ?? "what we're building";
  const name = cfg.founderName ?? "";
  return {
    subject: "quick question",
    body: [
      "Hey —",
      "",
      `Saw what you're working on and wanted to reach out. We're building ${product}.`,
      "",
      "Worth a short conversation?",
      "",
      name,
    ].join("\n"),
  };
}

/** Pick the two mailboxes, failing loudly rather than degrading to a meaningless self-send. */
export function resolveCanaryPair(opts: CanaryOptions = {}): {
  from: EmailIdentity;
  to: EmailIdentity;
} {
  const gmail = resolveIdentities(loadConfig()).filter((i) => i.provider === "gmail");
  if (gmail.length < 2) {
    throw new Error(
      `inbox-placement testing needs two authorized Gmail accounts (found ${gmail.length}) — ` +
        `a message sent to itself is never filtered, so a single account can't measure placement. ` +
        `Add a second with: bun run cli -- gmail auth`,
    );
  }
  const from = opts.fromIdentityId
    ? gmail.find((i) => i.id === opts.fromIdentityId)
    : (gmail[0] as EmailIdentity);
  if (!from) throw new Error(`no Gmail identity '${opts.fromIdentityId}' in the pool`);
  const to = opts.toIdentityId
    ? gmail.find((i) => i.id === opts.toIdentityId)
    : gmail.find((i) => i.id !== from.id);
  if (!to) throw new Error(`no Gmail identity '${opts.toIdentityId}' in the pool`);
  if (to.id === from.id) {
    throw new Error(
      "sender and recipient must be different identities — a self-send isn't filtered",
    );
  }
  return { from, to };
}

function domainOf(address: string): string {
  return address.split("@")[1]?.toLowerCase() ?? "";
}

/**
 * Why a same-domain result can't be trusted: mail between two mailboxes on one
 * Workspace domain is routed internally. It skips the spam filtering and the
 * SPF/DKIM/DMARC evaluation that a stranger's server would apply, so it reads
 * clean regardless of how the domain would actually be treated by a recipient.
 */
export const SAME_DOMAIN_WARNING =
  "both mailboxes are on the same domain — internal routing skips most filtering and authentication, " +
  "so this result does NOT predict how a stranger's mail server will treat you";

/** Placement measured against ONE mailbox is an anecdote, not a rate. */
export const SINGLE_SEED_CAVEAT =
  "one seed mailbox is a single data point, not an inbox-placement rate; " +
  "re-testing the same address repeatedly also trains its filter in your favour";

export async function runPlacementCanary(opts: CanaryOptions = {}): Promise<CanaryResult> {
  const ledger = getLedger();
  const { from, to } = resolveCanaryPair(opts);
  const fromAccount = gmailAccountFor(from);
  const toAccount = gmailAccountFor(to);
  if (!fromAccount) throw new Error(`no stored Gmail token for '${from.id}' — re-run: gmail auth`);
  if (!toAccount) throw new Error(`no stored Gmail token for '${to.id}' — re-run: gmail auth`);

  const fromAddress = from.address ?? (await getGmailProfile(fromAccount)).emailAddress;
  const toAddress = to.address ?? (await getGmailProfile(toAccount)).emailAddress;
  const sameDomain = domainOf(fromAddress) === domainOf(toAddress);

  // Replay real shipping copy where possible: filters judge content, so a
  // verdict on invented filler wouldn't transfer to the mail that matters.
  const real = ledger.latestSentEmailCopy(opts.playName ? { playName: opts.playName } : {});
  const copy = real ?? sampleCopy();
  const sourcePlay = real?.playName ?? null;

  // Sent directly, NOT through sendEmail: a diagnostic must not consume warm-up
  // capacity, pin a sender assignment, or leave a receipt that reads as outreach.
  const sentAt = Date.now();
  const sent = await sendGmailMessage(
    {
      to: toAddress,
      fromEmail: fromAddress,
      fromName: loadConfig().founderName,
      subject: copy.subject,
      // The real send path's exact encoder. Escaping matters beyond
      // correctness here: copy containing & < > would otherwise reach the
      // filter as different content from what ships, and the whole point is
      // to measure a verdict on the real thing.
      htmlBody: toHtmlBody(copy.body),
    },
    fromAccount,
  );

  // Gmail rewrites any Message-ID we supply, so read back the one it assigned.
  // Without this the receiving-side lookup has nothing exact to match on.
  const messageId = await getSentMessageId(sent.id, fromAccount).catch(() => null);
  // Subject+sender is the fallback query. Deliberately no marker token in the
  // subject: anything we added to make it findable would also be judged by the
  // filter we're trying to measure. `after:` is bounded to this run because the
  // subject is REPLAYED copy — an earlier canary of the same play would
  // otherwise be a valid match, and a stale hit would report the previous run's
  // placement as if it were this one's.
  const afterEpoch = Math.floor(sentAt / 1000) - 60;
  const query = messageId
    ? rfc822MsgIdQuery(messageId)
    : `from:${fromAddress} subject:"${copy.subject.replace(/"/g, "")}" after:${afterEpoch}`;

  const sleep = opts.sleep ?? sleepDefault;
  const deadline = sentAt + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  await sleep(FIRST_POLL_DELAY_MS);
  let found = await findPlacedMessage(query, toAccount);
  while (!found && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    found = await findPlacedMessage(query, toAccount);
  }

  const result: CanaryResult = {
    fromIdentity: from.id,
    fromAddress,
    toIdentity: to.id,
    toAddress,
    // Never seen inside the deadline. Reported as its own outcome rather than
    // folded into "spam" — it may still be in transit, and guessing either way
    // would be a fabricated verdict.
    placement: found?.placement ?? "not_delivered",
    labelIds: found?.labelIds ?? [],
    auth: found?.auth ?? { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
    subject: copy.subject,
    sourcePlay,
    sameDomain,
    latencyMs: found ? Date.now() - sentAt : null,
  };

  ledger.recordCanaryResult(result);
  logEvent("canary.placement", {
    placement: result.placement,
    same_domain: sameDomain,
    spf: result.auth.spf,
    dkim: result.auth.dkim,
    dmarc: result.auth.dmarc,
  });
  return result;
}
