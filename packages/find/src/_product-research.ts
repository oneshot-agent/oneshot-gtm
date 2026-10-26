import {
  deepResearch,
  getLedger,
  logEvent,
  parallelMap,
  type ProductResearchDossier,
  type ProductResearchSource,
  type QueueRow,
  RESEARCH_TOPIC_MAX,
  webRead,
} from "@oneshot-gtm/core";
import type { FinderResult } from "./_types.ts";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EXCERPT = 3_000;
const EXTERNAL_FAILURE_LIMIT = 3;
const EXTERNAL_COOLDOWN_MS = 5 * 60 * 1000;
const EXCLUDED_PLAYS = new Set(["breakup-revive", "x-amplify", "x-amplify-dm"]);
const DUD_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "live.com",
  "msn.com",
  "me.com",
  "gmx.com",
  "gmx.de",
  "web.de",
  "mail.ru",
  "yandex.ru",
  "yandex.com",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "naver.com",
]);

/**
 * Plays whose signal URL is someone else's project: a repository they
 * starred. Read as their own pages it made offers about that project, which
 * the judge rates weak by definition, so it is never read as first-party.
 */
const THIRD_PARTY_SIGNAL_PLAYS = new Set(["repo-interest"]);

let consecutiveExternalFailures = 0;
let externalCircuitUntil = 0;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(body: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Academic and alumni domains. A university address says where someone studied,
 * not where they work, and `https://<that domain>` is a university homepage,
 * or (for an alumni forwarder like `network.rca.ac.uk`) not a website at all.
 *
 * This is the shape that produced a dossier whose only source was a Luma
 * profile: the read of the alumni domain threw, and the profile page was all
 * that was left. Excluding these sends `seedFor` to the company instead.
 */
const ACADEMIC_DOMAIN = /(^|\.)(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/i;

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain || DUD_DOMAINS.has(domain) || ACADEMIC_DOMAIN.test(domain)) return null;
  return domain;
}

/**
 * The company domain a row's research would read: a stated company domain,
 * else a work email's. Null for a personal or academic address, or none.
 */
export function queueRowCompanyDomain(payload: JsonRecord): string | null {
  const stated = str(payload, "companyDomain", "newCompanyDomain", "guestCompanyDomain");
  if (stated) return stated;
  return emailDomain(str(payload, "email", "founderEmail", "guestEmail"));
}

/** True when the row carries text read from the company's own pages. */
export function hasCompanyPages(payload: JsonRecord): boolean {
  const research = payload["productResearch"];
  if (!isRecord(research) || !Array.isArray(research["sources"])) return false;
  return (research["sources"] as unknown[]).some(
    (s) => isRecord(s) && typeof s["excerpt"] === "string" && s["excerpt"].trim().length > 0,
  );
}

/** Plays whose rows never get company research. */
export function productResearchSkipsPlay(playName: string): boolean {
  return EXCLUDED_PLAYS.has(playName);
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function seedFor(
  row: ResearchableQueueRow,
  payload: JsonRecord,
): {
  name: string | null;
  company: string | null;
  urls: string[];
  cacheKey: string | null;
  known: JsonRecord;
} {
  const name = str(payload, "name", "founderName", "guestName", "hostName");
  const company = str(payload, "company", "newCompany", "guestCompany");
  const email = str(payload, "email", "founderEmail", "guestEmail");
  const domain = queueRowCompanyDomain(payload);
  const candidates = [
    THIRD_PARTY_SIGNAL_PLAYS.has(row.play_name)
      ? null
      : str(payload, "evidenceUrl", "repoUrl", "postUrl", "launchUrl", "jobUrl", "episodeUrl"),
    domain ? `https://${domain}` : null,
    str(payload, "sourceProfileUrl", "websiteUrl"),
  ];
  const urls = [...new Set(candidates.map(normalizeUrl).filter((u): u is string => Boolean(u)))];
  const productKey =
    urls[0]?.toLowerCase() ?? (company ? `company:${company.toLowerCase()}` : null);
  // External research is grounded in both the product and this contact's
  // signal/identity. Never reuse one person's dossier for a colleague or a
  // different stargazer of the same repository.
  const identityKey = email?.toLowerCase() ?? name?.toLowerCase() ?? `queue:${row.id}`;
  // `v2`: the research question changed; answers to the old one re-research.
  const cacheKey = productKey ? `v2|${productKey}|contact:${identityKey}` : null;
  return {
    name,
    company,
    urls,
    cacheKey,
    known: {
      play: row.play_name,
      source: row.source,
      signal: row.notes,
      vendorStack: payload["vendorStack"] ?? null,
      title: payload["title"] ?? null,
    },
  };
}

type ResearchSeed = ReturnType<typeof seedFor>;

/** Longest single fact in the subject: one long field never crowds out the rest. */
const TOPIC_FIELD_MAX = 100;

const TOPIC_ASK =
  "Research the company behind this prospect: what it sells and to whom, how it delivers, " +
  "its stage (headcount, funding, revenue), what changed in the last year (launches, funding, " +
  "hires, open roles), and what this person's role owns there. Cite source URLs; mark inference.";

/**
 * The research question for one row, within the platform's topic limit
 * (`RESEARCH_TOPIC_MAX`): the ask, then who it is about. The subject gives up
 * its least telling facts first (the signal, the play, the site, the title);
 * the name and the company, each clipped, always fit.
 */
export function productResearchTopic(
  seed: Pick<ResearchSeed, "name" | "company" | "urls" | "known">,
): string {
  const known = seed.known;
  const fields: Array<[label: string, value: unknown]> = [
    ["name", seed.name],
    ["company", seed.company],
    ["title", known["title"]],
    ["site", seed.urls[0]],
    ["play", known["play"]],
    ["signal", known["signal"]],
  ];
  const present = fields
    .map(
      ([label, value]) =>
        [
          label,
          typeof value === "string"
            ? value.replace(/\s+/g, " ").trim().slice(0, TOPIC_FIELD_MAX)
            : "",
        ] as const,
    )
    .filter(([, value]) => value.length > 0);
  for (let keep = present.length; keep >= 0; keep--) {
    const subject = present
      .slice(0, keep)
      .map(([label, value]) => `${label}: ${value}`)
      .join("; ");
    const topic = subject ? `${TOPIC_ASK} Subject: ${subject}` : TOPIC_ASK;
    if (topic.length <= RESEARCH_TOPIC_MAX) return topic;
  }
  return TOPIC_ASK.slice(0, RESEARCH_TOPIC_MAX);
}

function sourceKind(url: string): ProductResearchSource["kind"] {
  if (/github\.com\/[^/]+\/[^/]+/i.test(url)) return "repository";
  // `luma.com/user/<handle>` is a person's event profile. Classified as a
  // website it masqueraded as company research, and its "Nothing Here, Yet"
  // body counted as a sourced excerpt.
  if (/github\.com|linkedin\.com|x\.com|twitter\.com|luma\.com\/user\//i.test(url)) {
    return "profile";
  }
  return "website";
}

function externalUrls(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s)\]}>"']+/g)) out.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) externalUrls(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as JsonRecord)) externalUrls(item, out);
  }
  return out;
}

function unavailable(
  name: string | null,
  company: string | null,
  warning: string,
): ProductResearchDossier {
  return {
    version: 1,
    status: "unavailable",
    researchedAt: new Date().toISOString(),
    subject: { ...(name ? { name } : {}), ...(company ? { company } : {}) },
    sources: [],
    warning,
  };
}

type ResearchableQueueRow = Pick<
  QueueRow,
  "id" | "play_name" | "source" | "notes" | "payload_json"
>;

export async function researchQueueRowProduct(
  row: ResearchableQueueRow,
  opts: { remainingUsd: number; externalResearch?: boolean },
): Promise<{
  dossier: ProductResearchDossier;
  costUsd: number;
  cached: boolean;
}> {
  let payload: JsonRecord;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!isRecord(parsed)) {
      return {
        dossier: unavailable(null, null, "invalid queue payload: expected an object"),
        costUsd: 0,
        cached: false,
      };
    }
    payload = parsed;
  } catch {
    return {
      dossier: unavailable(null, null, "invalid queue payload"),
      costUsd: 0,
      cached: false,
    };
  }
  const seed = seedFor(row, payload);
  const ledger = getLedger();
  if (seed.cacheKey) {
    const cached = ledger.getProductResearchCache(seed.cacheKey, CACHE_TTL_MS);
    if (cached) {
      try {
        return {
          dossier: JSON.parse(cached) as ProductResearchDossier,
          costUsd: 0,
          cached: true,
        };
      } catch {
        // Corrupt cache is a miss and will be repaired by a successful call.
      }
    }
  }
  if (opts.remainingUsd <= 0) {
    return {
      dossier: unavailable(seed.name, seed.company, "product research skipped: cost cap reached"),
      costUsd: 0,
      cached: false,
    };
  }

  const sources: ProductResearchSource[] = [];
  let costUsd = 0;
  for (const url of seed.urls.slice(0, 2)) {
    if (costUsd >= opts.remainingUsd) break;
    try {
      const read = await webRead(
        { url },
        {
          playName: row.play_name,
          memo: `first-party product research before review`,
          decisionContext: {
            source: "finder.product-research",
            queueId: row.id,
            url,
          },
        },
      );
      costUsd += read.result.cost ?? 0;
      const excerpt = (read.result.markdown ?? "").trim().slice(0, MAX_EXCERPT);
      sources.push({
        url,
        kind: sourceKind(url),
        ...(excerpt ? { excerpt } : {}),
      });
    } catch (err) {
      logEvent(
        "product_research.web_read_failed",
        {
          queue_id: row.id,
          url,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }

  let external: unknown;
  let externalWarning: string | null = null;
  if (
    opts.externalResearch !== false &&
    costUsd < opts.remainingUsd &&
    (opts.externalResearch === true || Date.now() >= externalCircuitUntil)
  ) {
    try {
      const research = await deepResearch(
        { depth: "quick", topic: productResearchTopic(seed) },
        {
          playName: row.play_name,
          memo: `quick product research before queue review`,
          decisionContext: {
            source: "finder.product-research",
            queueId: row.id,
          },
        },
      );
      costUsd += research.result.cost ?? 0;
      external = research.result;
      consecutiveExternalFailures = 0;
      for (const url of externalUrls(research.result)) {
        if (!sources.some((s) => s.url === url)) sources.push({ url, kind: "external" });
      }
    } catch (err) {
      externalWarning = "external research failed; first-party evidence retained";
      consecutiveExternalFailures++;
      if (consecutiveExternalFailures >= EXTERNAL_FAILURE_LIMIT) {
        externalCircuitUntil = Date.now() + EXTERNAL_COOLDOWN_MS;
      }
      const status = (err as { statusCode?: unknown }).statusCode;
      logEvent(
        "product_research.external_failed",
        {
          queue_id: row.id,
          message_120: ((err as Error).message ?? "").slice(0, 120),
          // The SDK names every refused call "Tool request failed": the
          // status and the platform's own answer say why.
          status: typeof status === "number" ? status : null,
          body_120: String((err as { responseBody?: unknown }).responseBody ?? "").slice(0, 120),
          consecutive_failures: consecutiveExternalFailures,
          circuit_open_until:
            externalCircuitUntil > Date.now() ? new Date(externalCircuitUntil).toISOString() : null,
        },
        "warn",
      );
    }
  } else if (opts.externalResearch === false) {
    externalWarning = "external research disabled; first-party evidence retained";
  } else if (opts.externalResearch !== true && Date.now() < externalCircuitUntil) {
    externalWarning = "external research circuit open; first-party evidence retained";
  }

  const hasFirstParty = sources.some((s) => Boolean(s.excerpt));
  const dossier: ProductResearchDossier = {
    version: 1,
    status:
      external && hasFirstParty
        ? "complete"
        : external || hasFirstParty
          ? "partial"
          : "unavailable",
    researchedAt: new Date().toISOString(),
    subject: {
      ...(seed.name ? { name: seed.name } : {}),
      ...(seed.company ? { company: seed.company } : {}),
    },
    sources,
    ...(external ? { external } : {}),
    ...(!external
      ? {
          warning: hasFirstParty
            ? (externalWarning ?? "external research skipped; first-party evidence retained")
            : "no product research signal found",
        }
      : {}),
  };
  // A partial result usually means the external call failed. Keep the
  // first-party evidence on the row, but don't make that failure sticky for
  // 30 days. A later backfill/run should be allowed to complete it.
  if (seed.cacheKey && dossier.status === "complete") {
    ledger.setProductResearchCache(seed.cacheKey, JSON.stringify(dossier));
  }
  return { dossier, costUsd, cached: false };
}

/**
 * Replace a live row's company research (pending or approved, not sending).
 * The ledger's merge patch would keep keys of the old dossier the new one
 * lacks, so it is cleared first. False when the row is no longer live.
 */
export function writeLiveQueueProductResearch(
  id: number,
  dossier: ProductResearchDossier,
): boolean {
  const ledger = getLedger();
  if (!ledger.patchLiveQueuePayload({ id, patch: { productResearch: null } })) return false;
  return ledger.patchLiveQueuePayload({ id, patch: { productResearch: dossier } });
}

/** Enrich only rows produced by the just-finished finder run. */
export async function researchNewQueueRows(input: {
  afterId: number;
  result: FinderResult;
  maxCostUsd?: number;
  enabled: boolean;
  priorSdkCostUsd?: number;
}): Promise<void> {
  if (!input.enabled) return;
  const ledger = getLedger();
  const ownsSource = (source: string): boolean =>
    source === input.result.source ||
    source.startsWith(`${input.result.source}:`) ||
    input.result.source.startsWith(`${source}:`);
  const rows = ledger
    .listPendingQueueAfterId(input.afterId)
    .filter((row) => ownsSource(row.source) && !EXCLUDED_PLAYS.has(row.play_name));
  const initialResultCostUsd = input.result.costUsd;
  await parallelMap(rows, input.maxCostUsd === undefined ? 3 : 1, async (row) => {
    let payload: JsonRecord;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      payload = isRecord(parsed) ? parsed : {};
    } catch {
      return;
    }
    if (payload["productResearch"]) return;
    const remainingUsd = Math.max(
      0,
      (input.maxCostUsd ?? Number.POSITIVE_INFINITY) -
        ((input.priorSdkCostUsd ?? initialResultCostUsd) +
          (input.result.costUsd - initialResultCostUsd)),
    );
    const researched = await researchQueueRowProduct(row, { remainingUsd });
    input.result.costUsd += researched.costUsd;
    payload["productResearch"] = researched.dossier;
    ledger.updateQueuePayload({ id: row.id, payload });
    if (researched.dossier.status === "unavailable") {
      ledger.setQueueNotes({
        id: row.id,
        notes: [
          row.notes,
          `product research unavailable: ${researched.dossier.warning ?? "unknown"}`,
        ]
          .filter(Boolean)
          .join(" — "),
      });
    }
  });
}
