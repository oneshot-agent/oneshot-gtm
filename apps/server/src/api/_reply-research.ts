import {
  ENRICH_CACHE_TTL_MS,
  getLedger,
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
}): Promise<ReplyContext> {
  const ledger = getLedger();

  const threadSent = input.threadKey
    ? (ledger.getInboxThreads().get(input.threadKey)?.sent ?? [])
    : [];

  const parts: string[] = [];
  let costUsd = 0;
  let researched = false;

  // Tier 1: the dossier we already own.
  const stored =
    input.prospectId != null ? ledger.getProspectById(input.prospectId)?.dossier_json : null;
  if (stored?.trim()) {
    parts.push(stored.slice(0, DOSSIER_SLICE));
  } else {
    // Tier 2: paid research, bounded and gated.
    const domain = emailDomain(input.fromEmail)?.toLowerCase() ?? null;
    if (!isDudDomain(domain)) {
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

      const site = await readSenderSite(siteDomainFor(domain!));
      if (site) {
        parts.push(`WEBSITE (${domain}):\n${site.text}`);
        if (site.paid) {
          researched = true;
          costUsd += site.costUsd;
        }
      }
    }
  }

  return {
    dossier: parts.length > 0 ? parts.join("\n\n---\n\n") : null,
    threadSent,
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
 * Read the sender's site, cached in enrichment_cache under `webread:<domain>`
 * (30d TTL + negative-cache semantics). Returns null on any failure;
 * transient errors are NOT negative-cached (an outage must not suppress
 * research for a month). The cache write rides the LIVE promise, not the
 * deadline race — a read settling after the deadline was still PAID for and
 * must reach the cache.
 */
async function readSenderSite(
  domain: string,
): Promise<{ text: string; paid: boolean; costUsd: number } | null> {
  const ledger = getLedger();
  const cacheKey = `webread:${domain}`;

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
    { url: `https://${domain}` },
    {
      playName: PLAY_NAME,
      memo: `read sender's site (${domain}) before drafting a reply`,
    },
  ).then((read) => {
    const text = (read.result.markdown ?? "").trim().slice(0, WEBREAD_SLICE);
    if (text) bestEffort(() => ledger.setCachedEnrichment(cacheKey, JSON.stringify({ text })));
    return read;
  });
  // A deadline-abandoned promise must not surface as an unhandled rejection.
  live.catch(() => {});

  try {
    const read = await withDeadline(live, WEBREAD_DEADLINE_MS, `webRead ${domain}`);
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
      { domain, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}
