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
 * Assemble everything the reply drafter can know about the sender, cheapest
 * first:
 *
 * 1. Free — the prospect's stored dossier (finders/Add-Prospect already paid
 *    for it) and the founder's own prior replies in this thread.
 * 2. Paid, only when no dossier exists — enrich the sender's email (~$0.05,
 *    30d cache) and read their apex domain (~$0.01, cached here under
 *    `webread:<domain>`), both gated by isDudDomain so a gmail.com sender
 *    costs nothing.
 *
 * Best-effort throughout: research failing for ANY reason degrades to the
 *  free tiers — it must never block the draft (this also keeps demo mode
 * harmless, where placeholder keys fail at auth).
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

      const site = await readSenderSite(domain!);
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

/**
 * Read the sender's apex site (the aliyev.site call), cached in
 * enrichment_cache under `webread:<domain>` — the PK is a plain string, and
 * reusing the table gets us the 30d TTL + negative-cache semantics safeEnrich
 * already established. Returns null on any failure; transient errors are not
 * negative-cached (an outage must not suppress research for a month).
 */
async function readSenderSite(
  domain: string,
): Promise<{ text: string; paid: boolean; costUsd: number } | null> {
  const ledger = getLedger();
  const cacheKey = `webread:${domain}`;

  const cached = ledger.getCachedEnrichment(cacheKey);
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

  try {
    const read = await withDeadline(
      webRead(
        { url: `https://${domain}` },
        {
          playName: PLAY_NAME,
          memo: `read sender's site (${domain}) before drafting a reply`,
        },
      ),
      WEBREAD_DEADLINE_MS,
      `webRead ${domain}`,
    );
    const text = (read.result.markdown ?? "").trim().slice(0, WEBREAD_SLICE);
    if (!text) return null;
    const c = (read.result as unknown as { cost?: number }).cost;
    ledger.setCachedEnrichment(cacheKey, JSON.stringify({ text }));
    return { text, paid: true, costUsd: typeof c === "number" ? c : 0 };
  } catch (err) {
    if (!isTransientToolError(err)) {
      ledger.setCachedEnrichmentFailure(cacheKey, (err as Error).message ?? "webRead failed");
    }
    logEvent(
      "inbox.reply.research.webread_failed",
      { domain, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}
