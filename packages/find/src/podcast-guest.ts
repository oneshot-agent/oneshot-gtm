import { findEmail, getLedger, logEvent, verifyEmail, webRead, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { PodcastGuestTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import type { FinderResult, PodcastGuestExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "podcast-guest";
const SOURCE = "find:podcast-guest";

export interface PodcastGuestFinderOpts extends RunOpts {
  /** Podcasts to search. Default a small set of YC-adjacent shows. */
  podcasts?: string[];
  /** Days back to bias the search query. Default 21. */
  sinceDays?: number;
  /** Skip the deeper webRead step (cheaper but less accurate). */
  skipRead?: boolean;
}

const DEFAULT_PODCASTS = [
  "Latent Space",
  "Lenny's Podcast",
  "20VC",
  "Acquired",
  "Invest Like the Best",
];

interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export async function runPodcastGuestFinder(opts: PodcastGuestFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const sinceDays = opts.sinceDays ?? 21;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const system = loadPrompt("podcast-guest-extract");
  const podcasts = opts.podcasts && opts.podcasts.length > 0 ? opts.podcasts : DEFAULT_PODCASTS;

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const sincePhrase = sinceDays <= 7 ? "this week" : `last ${sinceDays} days`;

  for (const show of podcasts) {
    if (hits.length >= limit * 2) break;
    const query = `"${show}" episode guest ${sincePhrase}`;
    try {
      const search = await webSearch(
        { query, maxResults: Math.min(15, limit) },
        { playName: PLAY_NAME },
      );
      result.costUsd += search.result.cost ?? 0;
      for (const hit of search.result.results ?? []) {
        if (!hit.url || seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push({ url: hit.url, title: hit.title, description: hit.description });
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "podcast-guest.webSearch",
          show,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }
  result.candidates = hits.length;

  for (const hit of hits.slice(0, limit)) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    if (ledger.isQueueDuplicate(PLAY_NAME, hit.url)) {
      result.droppedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    const filter = await icpFilter({
      icp,
      candidate: { title: hit.title, url: hit.url, summary: hit.description },
    });
    if (!filter.match) {
      result.droppedIcp++;
      ledger.enqueueTarget({
        playName: PLAY_NAME,
        payload: { title: hit.title, url: hit.url, description: hit.description },
        dedupeKey: hit.url,
        source: SOURCE,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      continue;
    }

    let extract: PodcastGuestExtract;
    try {
      let payload: Record<string, unknown> = {
        url: hit.url,
        title: hit.title,
        description: hit.description,
      };
      if (!opts.skipRead) {
        const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
        result.costUsd += read.result.cost ?? 0;
        payload = { ...payload, markdown: (read.result.markdown ?? "").slice(0, 12000) };
      }
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
        temperature: 0.1,
        maxTokens: 500,
      });
      extract = parsePodcastGuestExtract(llm.content);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "podcast-guest.llm.extract",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      result.droppedEnrichment++;
      continue;
    }

    if (!extract.guestName || !extract.guestCompanyDomain || !extract.podcastName) {
      result.droppedEnrichment++;
      continue;
    }

    const found = await findEmail(
      { fullName: extract.guestName, companyDomain: extract.guestCompanyDomain },
      { playName: PLAY_NAME },
    );
    result.costUsd += found.result.cost ?? 0;
    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      continue;
    }
    const email = found.result.email;

    if (isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += verified.result.cost ?? 0;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

    let linkedinUrl: string | null = isLinkedInProfileUrl(extract.linkedinUrl)
      ? extract.linkedinUrl
      : null;
    if (!linkedinUrl) {
      linkedinUrl = await findLinkedInUrl({
        fullName: extract.guestName,
        disambiguators: [extract.podcastName],
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "podcast-guest",
      });
    }

    const target: PodcastGuestTarget = {
      name: extract.guestName,
      email,
      company: extract.guestCompany ?? extract.guestCompanyDomain,
      podcast: extract.podcastName,
      episodeTitle: extract.episodeTitle ?? hit.title,
      hookQuote: (extract.summary ?? hit.description ?? "").slice(0, 240),
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(extract.phone ? { phone: extract.phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.url,
      source: SOURCE,
      notes: `${extract.guestName} on ${extract.podcastName} — ${filter.reason}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function parsePodcastGuestExtract(raw: string): PodcastGuestExtract {
  return tryParseJsonObject<PodcastGuestExtract>(raw, {
    podcastName: null,
    episodeTitle: null,
    episodeUrl: null,
    guestName: null,
    guestRole: null,
    guestCompany: null,
    guestCompanyDomain: null,
    publishedAt: null,
    linkedinUrl: null,
    phone: null,
    summary: null,
  });
}
