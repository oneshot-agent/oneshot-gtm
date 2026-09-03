import {
  deepResearch,
  getLedger,
  logEvent,
  parallelMap,
  type ProductResearchDossier,
  type ProductResearchSource,
  type QueueRow,
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
]);

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

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  return domain && !DUD_DOMAINS.has(domain) ? domain : null;
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
  const domain =
    str(payload, "companyDomain", "newCompanyDomain", "guestCompanyDomain") ?? emailDomain(email);
  const candidates = [
    str(payload, "evidenceUrl", "repoUrl", "postUrl", "launchUrl", "jobUrl", "episodeUrl"),
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
  const cacheKey = productKey ? `${productKey}|contact:${identityKey}` : null;
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

function sourceKind(url: string): ProductResearchSource["kind"] {
  if (/github\.com\/[^/]+\/[^/]+/i.test(url)) return "repository";
  if (/github\.com|linkedin\.com|x\.com|twitter\.com/i.test(url)) return "profile";
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
        {
          depth: "quick",
          topic: [
            `Research the current product and company behind this qualified prospect.`,
            `Identify what they are building, the product ecosystem, architecture/integrations, business model,`,
            `and whether payments are a product capability, monetization layer, or separate product.`,
            `Use current public sources, distinguish sourced facts from inference, and include source URLs.`,
            `Subject: ${JSON.stringify({ name: seed.name, company: seed.company, urls: seed.urls, known: seed.known })}`,
          ].join(" "),
        },
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
      logEvent(
        "product_research.external_failed",
        {
          queue_id: row.id,
          message_120: ((err as Error).message ?? "").slice(0, 120),
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
  // 30 days — a later backfill/run should be allowed to complete it.
  if (seed.cacheKey && dossier.status === "complete") {
    ledger.setProductResearchCache(seed.cacheKey, JSON.stringify(dossier));
  }
  return { dossier, costUsd, cached: false };
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
