import { createHash } from "node:crypto";
import { getLedger, logEvent, webRead } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { sanitizeCompanyDomain } from "./_accelerator-search-adapter.ts";
import { icpFields, resolveVerifyEnrichQualify } from "./_contact.ts";
import { isDuplicate } from "./_dedupe.ts";
import { resolveIcp } from "./_filter.ts";
import { buildDesignPartnerLoiPayload, dedupePlayNames, resolvePlayRoute } from "./_play-route.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection } from "./_qualify.ts";
import { safeCompanySearch } from "./_sdk-safe.ts";
import type { FinderResult, ListPageCompany, RunOpts } from "./_types.ts";

/**
 * list-page: any public page that lists companies (an open-source project's
 * ADOPTERS file, a sponsor page, a customers page) becomes a source. Each
 * source carries the `signal` that being on the list means ("runs
 * Backstage"); every row is stamped with it and with the page's own line for
 * that company, so an angle can key on it and the writer can say how the
 * company was found. The person is the company's decision owner, found by
 * the shared domain-only contact spine. Names the page gives (often the
 * engineers who set the tool up) are kept as context, never emailed.
 *
 * Enterprise routing only for now: rows go to `design-partner-loi` with a
 * `buyerType`, and a run without that route enqueues nothing.
 */

const PLAY_NAME = "design-partner-loi";
const SOURCE = "find:list-page";
const FETCH_TIMEOUT_MS = 30_000;
const UA = "Mozilla/5.0 (compatible; oneshot-gtm list-page)";
/** Characters per extraction call: small enough that a dense table's JSON fits the output budget. */
const CHUNK_CHARS = 6_000;
/** A page longer than this is cut: a list that long is not a list of buyers. */
const MAX_PAGE_CHARS = 400_000;
/** Re-extract an unchanged page at most this often (the cache key also carries a content hash). */
const EXTRACT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTEXT_CHARS = 240;

export interface ListPageSource {
  url: string;
  /** What being on this list means, in a few words ("runs Backstage"). */
  signal: string;
}

export interface ListPageOpts extends RunOpts {
  sources: ListPageSource[];
  /** The angles for design-partner-loi (`//`-separated). */
  yourEdge?: string;
  /** Must be `design-partner-loi` in this version. */
  play?: string;
  buyerType?: string;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "list"
  );
}

/** A GitHub file page (`/blob/`) read as its raw text, which is free and exact. */
export function rawGitHubUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;
  const [owner, repo, , ref, ...path] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`;
}

/** Split a page into chunks on line boundaries, each at most `max` characters. */
export function chunkLines(text: string, max: number = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const piece = line.length > max ? line.slice(0, max) : line;
    if (cur.length + piece.length + 1 > max && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The companies one extraction call returned, coerced; nameless rows dropped. */
export function parseListPageExtract(raw: string): ListPageCompany[] {
  const parsed = tryParseJsonObject<{ companies?: unknown }>(raw, { companies: [] });
  const list = Array.isArray(parsed.companies) ? parsed.companies : [];
  const out: ListPageCompany[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = str(r["name"]);
    if (!name) continue;
    const contacts: ListPageCompany["contacts"] = [];
    for (const c of Array.isArray(r["contacts"]) ? r["contacts"] : []) {
      const rc = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
      const contact: ListPageCompany["contacts"][number] = {};
      const cname = str(rc["name"]);
      const github = str(rc["github"]);
      const linkedin = str(rc["linkedin"]);
      if (cname) contact.name = cname;
      if (github) contact.github = github.replace(/^@/, "");
      if (linkedin) contact.linkedin = linkedin;
      if (Object.keys(contact).length > 0) contacts.push(contact);
    }
    out.push({
      name,
      domain: sanitizeCompanyDomain(str(r["website"]) ?? str(r["domain"])),
      context: str(r["context"])?.slice(0, CONTEXT_CHARS) ?? null,
      contacts,
    });
  }
  return out;
}

/** One company per domain (else per name), first mention wins. */
export function dedupeCompanies(companies: ListPageCompany[]): ListPageCompany[] {
  const seen = new Set<string>();
  return companies.filter((c) => {
    const key = c.domain ?? `name:${c.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/plain,text/markdown,text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** The page's text: a GitHub file straight from raw (free), anything else through webRead. */
async function readPage(url: string): Promise<{ text: string; costUsd: number }> {
  const raw = rawGitHubUrl(url);
  if (raw) return { text: await fetchText(raw), costUsd: 0 };
  const read = await webRead({ url }, { playName: PLAY_NAME, memo: "list-page source" });
  return { text: read.result.markdown ?? "", costUsd: read.result.cost ?? 0 };
}

/**
 * Every company on the page. Cached by URL and content hash, so an
 * unchanged list costs no extraction calls on the next run.
 */
export async function extractListPage(
  source: ListPageSource,
  text: string,
): Promise<ListPageCompany[]> {
  const page = text.slice(0, MAX_PAGE_CHARS);
  const hash = createHash("sha256").update(page).digest("hex").slice(0, 16);
  const cacheKey = `list-page:${source.url}:${hash}`;
  const ledger = getLedger();
  const cached = ledger.getProductResearchCache(cacheKey, EXTRACT_CACHE_TTL_MS);
  if (cached) {
    try {
      return JSON.parse(cached) as ListPageCompany[];
    } catch {
      // corrupt entry: re-extract and overwrite
    }
  }
  const system = loadPrompt("list-page-extract");
  const chunks = chunkLines(page);
  const companies: ListPageCompany[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const llm = await complete({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            url: source.url,
            signal: source.signal,
            part: `${i + 1} of ${chunks.length}`,
            markdown: chunk,
          }),
        },
      ],
      temperature: 0.1,
      maxTokens: 4000,
    });
    companies.push(...parseListPageExtract(llm.content));
  }
  const unique = dedupeCompanies(companies);
  ledger.setProductResearchCache(cacheKey, JSON.stringify(unique));
  return unique;
}

export async function runListPageFinder(opts: ListPageOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const route = resolvePlayRoute(opts);
  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
    perSource: [],
  };
  if (!route) {
    result.halted = "list-page routes to design-partner-loi only: set `play` and `buyerType`";
    return result;
  }
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const dedupeScope = dedupePlayNames(PLAY_NAME);
  const yourEdge = (opts.yourEdge ?? "").trim();
  let worked = 0;

  for (const source of opts.sources) {
    const slug = slugify(source.signal);
    const rowSource = `${SOURCE}:${slug}`;
    let companies: ListPageCompany[];
    try {
      const page = await readPage(source.url);
      result.costUsd += page.costUsd;
      companies = await extractListPage(source, page.text);
      result.perSource!.push({
        source: source.url,
        label: source.signal,
        records: companies.length,
      });
    } catch (err) {
      const message = ((err as Error).message ?? "").slice(0, 120);
      logEvent(
        "error.swallowed",
        { kind: "list-page.read_or_extract", message_120: message },
        "warn",
      );
      result.perSource!.push({
        source: source.url,
        label: source.signal,
        records: 0,
        error: message,
      });
      continue;
    }
    result.candidates += companies.length;

    for (const company of companies) {
      if (worked >= limit) {
        result.halted = `limit (${limit})`;
        return result;
      }
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
        result.halted = `max-cost cap (${opts.maxCostUsd})`;
        return result;
      }
      const dedupeKey = `list-page:${company.domain ?? `name:${slugify(company.name)}`}`;
      if (dedupeScope.some((p) => ledger.isQueueDuplicate(p, dedupeKey))) {
        result.droppedDuplicate++;
        continue;
      }
      worked++;
      if (opts.dryRun) {
        result.enqueued++;
        continue;
      }

      let domain = company.domain;
      if (!domain) {
        const found = await safeCompanySearch(
          { name: company.name, limit: 1 },
          { playName: PLAY_NAME },
        );
        result.costUsd += found.result.cost ?? 0;
        domain = sanitizeCompanyDomain(found.result.results?.[0]?.domain ?? null);
      }
      if (!domain) {
        result.droppedEnrichment++;
        continue;
      }

      const evidence = company.context ? `${source.signal}: ${company.context}` : source.signal;
      const contact = await resolveVerifyEnrichQualify({
        playName: PLAY_NAME,
        fullName: null,
        allowMissingFullName: true,
        companyDomain: domain,
        isDuplicate: (email) =>
          isDuplicate({ playName: dedupeScope, dedupeKey, prospectEmail: email }),
        icp,
        person: { name: null, company: company.name, roleText: null, evidence },
        fillGaps: opts.qualifyFillGaps ?? true,
        errKindPrefix: "list-page",
      });
      result.costUsd += contact.costUsd;
      if (!contact.ok) {
        if (contact.reason === "duplicate") result.droppedDuplicate++;
        else if (contact.reason === "role") {
          result.droppedRole = (result.droppedRole ?? 0) + 1;
          persistRoleRejection({
            playName: PLAY_NAME,
            dedupeKey,
            payload: { company: company.name, signal: source.signal },
            source: rowSource,
            reason: contact.detail ?? "off-ICP role",
            dryRun: opts.dryRun,
          });
        } else result.droppedEnrichment++;
        continue;
      }

      const listContact = company.contacts
        .map((c) => c.name ?? (c.github ? `@${c.github}` : null))
        .filter((c): c is string => c !== null)
        .join(", ");
      const payload = {
        ...buildDesignPartnerLoiPayload({
          name: contact.fullName ?? company.name,
          email: contact.email ?? "",
          company: company.name,
          buyerType: route.buyerType,
          yourEdge,
          title: contact.title,
          linkedinUrl: contact.linkedinUrl,
          phone: contact.phone,
          icp: icpFields(contact),
        }),
        signal: source.signal,
        ...(company.context ? { signalContext: company.context } : {}),
        ...(listContact ? { listContact: listContact.slice(0, CONTEXT_CHARS) } : {}),
        companyDomain: domain,
        launchUrl: `https://${domain}`,
        sourceUrl: source.url,
      };
      const id = enqueueScoredTarget(ledger, {
        playName: route.playName,
        payload,
        dedupeKey,
        source: rowSource,
        notes: evidence.slice(0, 300),
        channel: contact.channel,
      });
      if (id != null) result.enqueued++;
      else result.droppedDuplicate++;
    }
  }
  return result;
}
