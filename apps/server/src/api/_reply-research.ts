import {
  ENRICH_CACHE_TTL_MS,
  getLedger,
  hasDossierSignal,
  isTransientToolError,
  logEvent,
  webRead,
  withDeadline,
} from "@oneshot-gtm/core";
import { emailDomain, safeEnrich } from "@oneshot-gtm/plays";
import { isDudDomain } from "@oneshot-gtm/find";

const PLAY_NAME = "inbox-reply";
/** webRead is normally seconds; a hung fetch must not pin the draft button. */
const WEBREAD_DEADLINE_MS = 30_000;
/** Keep the combined research block prompt-sized. */
const DOSSIER_SLICE = 5000;
const WEBREAD_SLICE = 3500;

export interface ReplyContext {
  /** Combined research text for the SENDER DOSSIER block; null = nothing known. */
  dossier: string | null;
  /** Replies the founder already sent in this thread (oldest first). */
  threadSent: Array<{ body: string; sentAt: string }>;
  /** The prospect's earlier inbound messages (persisted replies, oldest first) — the other half of the exchange. */
  priorInbound: Array<{ body: string; subject: string | null; receivedAt: string }>;
  /** Paid spend this call actually incurred (cache hits are $0). */
  costUsd: number;
  /** True when a paid research call ran (vs. free/cached context only). */
  researched: boolean;
}

/**
 * Assemble sender context cheapest-first: (1) free — stored dossier + prior
 * replies in this thread; (2) paid, only when no dossier exists — enrich the
 * email and read the apex domain, both gated by isDudDomain. Best-effort
 * throughout: research failing for ANY reason must never block the draft.
 */
export async function gatherReplyContext(input: {
  fromEmail: string;
  prospectId: number | null;
  threadKey: string | null;
  /** Provider id of the email being answered — excluded from priorInbound (it IS the inbound). */
  excludeId?: string | null;
  /** Skip the paid tier entirely (enrich + site read) — set for non-human inbound (OOO/unsubscribe). */
  skipPaid?: boolean;
}): Promise<ReplyContext> {
  const ledger = getLedger();

  const threadSent = input.threadKey
    ? (ledger.getInboxThreads().get(input.threadKey)?.sent ?? [])
    : [];

  // Tier 0 (free): the prospect's earlier inbound messages from the ledger —
  // the drafter should see the whole exchange, not just the newest email.
  const priorInbound =
    input.prospectId != null
      ? ledger
          .listInboxRepliesForProspect(input.prospectId)
          .filter((r) => r.id !== input.excludeId)
          .map((r) => ({ body: r.body, subject: r.subject, receivedAt: r.received_at }))
      : [];

  const parts: string[] = [];
  let costUsd = 0;
  let researched = false;

  // Tier 1: the dossier we already own.
  //
  // hasDossierSignal, not a bare trim: a contentless dossier (a failed enrich
  // serialized to `{"status":"failed",...}`, or a person lookup that found
  // nobody) is non-empty but says nothing, and accepting it here would skip
  // the paid tiers below and hand the drafter no facts at all. Writers are
  // gated too; this guards rows written before that gate existed.
  const prospect = input.prospectId != null ? ledger.getProspectById(input.prospectId) : null;
  const stored = prospect?.dossier_json;
  if (stored?.trim() && hasDossierSignal(stored)) {
    parts.push(stored.slice(0, DOSSIER_SLICE));
  } else {
    // Tier 2: paid research, bounded and gated.
    const domain = emailDomain(input.fromEmail)?.toLowerCase() ?? null;
    if (input.skipPaid) {
      // Non-human inbound (OOO, unsubscribe): no one to ground a draft for.
    } else if (isDudDomain(domain)) {
      // Tier 2b: a personal-provider address has no company site to read and
      // nothing for enrich to key on, so both are skipped — which used to
      // leave the drafter with zero facts about the sender. The finder's
      // source_profile_url (GitHub / X / Luma) is the one handle we do own.
      // webRead, not deepResearchPerson: this runs behind the founder's
      // "draft reply" click, and deepResearchPerson is a 2-5 minute async call.
      const profileUrl = profileUrlFor(prospect?.source_profile_url ?? null);
      if (profileUrl) {
        const page = await readSenderPage(profileUrl, profileUrl);
        if (page) {
          parts.push(`PROFILE (${profileUrl}):\n${page.text}`);
          if (page.paid) {
            researched = true;
            costUsd += page.costUsd;
          }
        }
      }
    } else {
      try {
        const enr = await safeEnrich(
          { email: input.fromEmail },
          {
            playName: PLAY_NAME,
            memo: `research sender before drafting a reply`,
            decisionContext: { reason: "unknown sender replied; enrich before drafting" },
          },
        );
        const status = (enr.result as { status?: string }).status;
        if (enr.result && status !== "failed") {
          parts.push(JSON.stringify(enr.result, null, 2).slice(0, DOSSIER_SLICE));
          // receiptId 0 = cache hit, no spend.
          if (enr.receiptId !== 0) {
            researched = true;
            const c = (enr.result as { cost?: number }).cost;
            costUsd += typeof c === "number" ? c : 0;
          }
        }
      } catch (err) {
        // safeEnrich shouldn't throw, but the draft outranks any research bug.
        logEvent(
          "inbox.reply.research.enrich_failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }

      const site = siteDomainFor(domain!);
      const page = await readSenderPage(`https://${site}`, site);
      if (page) {
        parts.push(`WEBSITE (${domain}):\n${page.text}`);
        if (page.paid) {
          researched = true;
          costUsd += page.costUsd;
        }
      }
    }
  }

  return {
    dossier: parts.length > 0 ? parts.join("\n\n---\n\n") : null,
    threadSent,
    priorInbound,
    costUsd,
    researched,
  };
}

/** Cache writes are strictly best-effort — a SQLite hiccup must never turn a successful read into a failure. */
function bestEffort(fn: () => void): void {
  try {
    fn();
  } catch {
    // deliberately swallowed
  }
}

/**
 * Normalize the finder's stored profile URL into something safe to fetch.
 * These rows are written by our own finders, so this is a guard against bad
 * data (a bare handle, a `mailto:`), not against an attacker. Returns null
 * when there is nothing fetchable.
 */
export function profileUrlFor(raw: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // A bare profile host with no path is the finder's fallback, not a profile.
  if (parsed.pathname === "/" || parsed.pathname === "") return null;
  return parsed.toString();
}

/**
 * Strip a well-known mail-ish first label (mail.example.com serves MX, not a
 * website). A full public-suffix list is deliberately out of scope, so
 * multi-label TLDs pass through unchanged.
 */
const MAIL_SUBDOMAINS = new Set(["mail", "email", "smtp", "mx", "mta", "mailer", "send", "post"]);
export function siteDomainFor(domain: string): string {
  const labels = domain.split(".");
  return labels.length > 2 && MAIL_SUBDOMAINS.has(labels[0]!) ? labels.slice(1).join(".") : domain;
}

/**
 * Read one page about the sender — their company site, or the profile URL the
 * finder sourced them from — cached in enrichment_cache under `webread:<label>`
 * (30d TTL + negative-cache semantics). Returns null on any failure;
 * transient errors are NOT negative-cached (an outage must not suppress
 * research for a month). The cache write rides the LIVE promise, not the
 * deadline race — a read settling after the deadline was still PAID for and
 * must reach the cache.
 */
async function readSenderPage(
  url: string,
  label: string,
): Promise<{ text: string; paid: boolean; costUsd: number } | null> {
  const ledger = getLedger();
  const cacheKey = `webread:${label}`;

  let cached: ReturnType<typeof ledger.getCachedEnrichment> = null;
  try {
    cached = ledger.getCachedEnrichment(cacheKey);
  } catch {
    // cache-READ failure = cache miss, not a research failure
  }
  if (cached) {
    const fresh = Date.now() - new Date(cached.fetched_at).getTime() < ENRICH_CACHE_TTL_MS;
    if (fresh) {
      if (cached.status === "failed") return null;
      try {
        const parsed = JSON.parse(cached.result_json) as { text?: string };
        if (parsed.text) return { text: parsed.text, paid: false, costUsd: 0 };
      } catch {
        // corrupt cache row — fall through and refetch
      }
    }
  }

  const live = webRead(
    { url },
    {
      playName: PLAY_NAME,
      memo: `read sender's page (${label}) before drafting a reply`,
    },
  ).then((read) => {
    const text = (read.result.markdown ?? "").trim().slice(0, WEBREAD_SLICE);
    if (text) bestEffort(() => ledger.setCachedEnrichment(cacheKey, JSON.stringify({ text })));
    return read;
  });
  // A deadline-abandoned promise must not surface as an unhandled rejection.
  live.catch(() => {});

  try {
    const read = await withDeadline(live, WEBREAD_DEADLINE_MS, `webRead ${label}`);
    const text = (read.result.markdown ?? "").trim().slice(0, WEBREAD_SLICE);
    if (!text) return null;
    const c = (read.result as unknown as { cost?: number }).cost;
    return { text, paid: true, costUsd: typeof c === "number" ? c : 0 };
  } catch (err) {
    if (!isTransientToolError(err)) {
      bestEffort(() =>
        ledger.setCachedEnrichmentFailure(cacheKey, (err as Error).message ?? "webRead failed"),
      );
    }
    logEvent(
      "inbox.reply.research.webread_failed",
      { domain: label, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}
