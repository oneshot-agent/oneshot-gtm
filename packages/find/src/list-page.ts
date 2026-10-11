import { createHash } from "node:crypto";
import { getLedger, logEvent, type PersonResult, webRead } from "@oneshot-gtm/core";
import { complete, LlmTruncatedError, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { sanitizeCompanyDomain } from "./_accelerator-search-adapter.ts";
import { icpFields, type QualifiedContact, resolveVerifyEnrichQualify } from "./_contact.ts";
import { isDuplicate } from "./_dedupe.ts";
import { resolveIcp } from "./_filter.ts";
import { buildDesignPartnerLoiPayload, dedupePlayNames, resolvePlayRoute } from "./_play-route.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection } from "./_qualify.ts";
import { roundRobin } from "./_rank.ts";
import { safeCompanySearch, safePeopleSearch } from "./_sdk-safe.ts";
import { type SignalVerifyConfig, verifySignal } from "./_signal-verify.ts";
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
/**
 * Lines per extraction call. A bare `1. [Name](url)` list fits 130 companies
 * in 6,000 characters, and their JSON overran the output budget (measured
 * 2026-10-10 on two such lists: the whole source was lost).
 */
const CHUNK_LINES = 60;
/** A page longer than this is cut: a list that long is not a list of buyers. */
const MAX_PAGE_CHARS = 400_000;
/** Re-extract an unchanged page at most this often (the cache key also carries a content hash). */
const EXTRACT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Waits before the second and third attempt at reading a source. */
const READ_RETRY_WAITS_MS = [2_000, 8_000];
/**
 * How long a company where no one matched `jobTitles` is left alone. A miss
 * is a fact about that day's search, not about the company: the person may
 * be added to the database, or the search may have been degraded.
 */
const TITLE_MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTEXT_CHARS = 240;

export interface ListPageSource {
  url: string;
  /** What being on this list means, in a few words ("runs Backstage"). */
  signal: string;
  /**
   * Check each company's own evidence before the paid contact step: for a
   * list someone else compiled. Unset for a list companies add themselves
   * to (an ADOPTERS file). A clear miss is dropped; no evidence either way
   * is kept and labelled unconfirmed.
   */
  verify?: SignalVerifyConfig;
}

export interface ListPageOpts extends RunOpts {
  sources: ListPageSource[];
  /** The angles for design-partner-loi (`//`-separated). */
  yourEdge?: string;
  /**
   * Titles to look for at each company, most wanted first (e.g. "Head of AI
   * Platform", "VP Platform Engineering"). Set: one people search per company
   * scoped to these titles, candidates tried in this order. Empty: the
   * domain-only pick of any senior title (which at a large company can land
   * on PR or recruiting).
   */
  jobTitles?: string[];
  /** Must be `design-partner-loi` in this version. */
  play?: string;
  buyerType?: string;
}

export function slugify(text: string): string {
  const dashed = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Trim edge dashes by index: an anchored `-+$` backtracks on long dash runs.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === "-") start++;
  while (end > start && dashed[end - 1] === "-") end--;
  return dashed.slice(start, end).slice(0, 60) || "list";
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

const PLAIN_TEXT_PATH = /\.(json|ya?ml|md|markdown|txt|csv)$/i;

/**
 * A source that is already plain text, read with one free fetch: a GitHub
 * file page (as its raw file), a raw GitHub URL, or a data file (JSON, YAML,
 * Markdown, text). Null for a web page, which needs rendering.
 */
export function directTextUrl(url: string): string | null {
  const raw = rawGitHubUrl(url);
  if (raw) return raw;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === "raw.githubusercontent.com") return u.toString();
  return PLAIN_TEXT_PATH.test(u.pathname) ? u.toString() : null;
}

/**
 * JSON as lines the chunker can cut between: one array item per line. A
 * members file is often a single line, which would otherwise be cut off at
 * the first chunk. Anything that is not JSON is returned as it came.
 */
export function jsonAsLines(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (Array.isArray(parsed)) return parsed.map((item) => JSON.stringify(item)).join("\n");
  return JSON.stringify(parsed, null, 1);
}

/** Split a page into chunks on line boundaries, each at most `max` characters and `maxLines` lines. */
export function chunkLines(
  text: string,
  max: number = CHUNK_CHARS,
  maxLines: number = CHUNK_LINES,
): string[] {
  const chunks: string[] = [];
  let cur = "";
  let lines = 0;
  for (const line of text.split("\n")) {
    const piece = line.length > max ? line.slice(0, max) : line;
    if (cur && (cur.length + piece.length + 1 > max || lines >= maxLines)) {
      chunks.push(cur);
      cur = "";
      lines = 0;
    }
    cur = cur ? `${cur}\n${piece}` : piece;
    lines++;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A list's own tag on an entry: its membership tier, in parentheses after the name. */
const LIST_TAGS = new Set(
  [
    "member",
    "supporter",
    "contributor",
    "adopter",
    "end user",
    "sponsor",
    "partner",
    "user",
  ].flatMap((tag) => [tag, `${tag}s`]),
);

/**
 * The company's name without the list's tag on it. A members file writes
 * "Adobe (member)" and an adopters table "Bloomberg*"; the tag would
 * otherwise be the company name the email is written with. Trimmed by index,
 * not by an end-anchored pattern, which backtracks on a long run of marks.
 */
export function listedName(name: string): string {
  let out = name.trim();
  for (;;) {
    let end = out.length;
    while (end > 0 && out[end - 1] === "*") end--;
    let next = out.slice(0, end).trimEnd();
    if (next.endsWith(")")) {
      const open = next.lastIndexOf("(");
      const tag =
        open === -1
          ? ""
          : next
              .slice(open + 1, -1)
              .trim()
              .toLowerCase();
      if (LIST_TAGS.has(tag.replaceAll("-", " "))) next = next.slice(0, open).trimEnd();
    }
    if (next === out) return out;
    out = next;
  }
}

/** The companies one extraction call returned, coerced; nameless rows dropped. */
export function parseListPageExtract(raw: string): ListPageCompany[] {
  const parsed = tryParseJsonObject<{ companies?: unknown }>(raw, { companies: [] });
  const list = Array.isArray(parsed.companies) ? parsed.companies : [];
  const out: ListPageCompany[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = listedName(str(r["name"]) ?? "");
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

/** An HTTP status worth a second try: the server's trouble, not the URL's. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Fetch a text file, trying again after a network failure or a server error.
 * A run that fires as a laptop wakes finds no network for a few seconds; one
 * failed read would otherwise cost the source its whole interval.
 */
async function fetchText(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const wait = READ_RETRY_WAITS_MS[attempt];
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept: "text/plain,text/markdown,application/json,text/html,*/*",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (wait === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (res.ok) return res.text();
    if (wait === undefined || !retryableStatus(res.status)) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** The page's text: a plain-text source with one free fetch, anything else through webRead. */
async function readPage(url: string): Promise<{ text: string; costUsd: number }> {
  const direct = directTextUrl(url);
  if (direct) return { text: jsonAsLines(await fetchText(direct)), costUsd: 0 };
  const read = await webRead({ url }, { playName: PLAY_NAME, memo: "list-page source" });
  return { text: read.result.markdown ?? "", costUsd: read.result.cost ?? 0 };
}

/** How many times one chunk is halved before a cut-off reply fails the source. */
const MAX_CHUNK_SPLITS = 3;

/**
 * The companies in one chunk. A reply cut off at the token limit means the
 * chunk named more companies than fit: halve it and ask for each half.
 */
async function extractChunk(
  source: ListPageSource,
  system: string,
  chunk: string,
  part: string,
  depth: number,
): Promise<ListPageCompany[]> {
  try {
    const llm = await complete({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            url: source.url,
            signal: source.signal,
            part,
            markdown: chunk,
          }),
        },
      ],
      temperature: 0.1,
      maxTokens: 4000,
    });
    return parseListPageExtract(llm.content);
  } catch (err) {
    const lines = chunk.split("\n");
    if (!(err instanceof LlmTruncatedError) || depth >= MAX_CHUNK_SPLITS || lines.length < 2) {
      throw err;
    }
    const mid = Math.ceil(lines.length / 2);
    const halves = [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")];
    const out: ListPageCompany[] = [];
    for (const half of halves) {
      out.push(...(await extractChunk(source, system, half, part, depth + 1)));
    }
    return out;
  }
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
      // Names cleaned on the way out too: a page extracted before the tag
      // was stripped is still cached with it.
      const companies = JSON.parse(cached) as ListPageCompany[];
      for (const company of companies) company.name = listedName(company.name);
      return companies;
    } catch {
      // corrupt entry: re-extract and overwrite
    }
  }
  const system = loadPrompt("list-page-extract");
  const chunks = chunkLines(page);
  const companies: ListPageCompany[] = [];
  for (const [i, chunk] of chunks.entries()) {
    companies.push(
      ...(await extractChunk(source, system, chunk, `${i + 1} of ${chunks.length}`, 0)),
    );
  }
  const unique = dedupeCompanies(companies);
  ledger.setProductResearchCache(cacheKey, JSON.stringify(unique));
  return unique;
}

/** Candidates tried per company before the company is recorded as a miss. */
const MAX_OWNER_ATTEMPTS = 3;

function personName(p: PersonResult): string | null {
  const full = p.full_name?.trim() || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
  return full || null;
}

/** Long forms and rank prefixes written as the short word people put in a `jobTitles` entry. */
const TITLE_ALIASES: Array<[RegExp, string]> = [
  [/\b(?:senior|executive|assistant|associate) vice president\b/g, "vp"],
  [/\bvice president\b/g, "vp"],
  [/\b(?:svp|evp|avp)\b/g, "vp"],
  [/\bartificial intelligence\b/g, "ai"],
  [/\bmachine learning\b/g, "ml"],
  [/\bchief technology officer\b/g, "cto"],
  [/\bchief information officer\b/g, "cio"],
  [/\bchief executive officer\b/g, "ceo"],
];
const TITLE_FILLER = new Set(["of", "the", "and", "for", "at", "in"]);

/** A title as whole lowercase words, aliases folded in and filler words dropped. */
export function titleWords(title: string): string[] {
  let text = title.toLowerCase();
  for (const [pattern, short] of TITLE_ALIASES) text = text.replace(pattern, short);
  return text.split(/[^a-z0-9]+/).filter((w) => w && !TITLE_FILLER.has(w));
}

/**
 * Does `title` carry every word of the wanted title, as whole words? Whole
 * words because a substring test calls a Director a CTO (dire-cto-r) and a
 * Head of Retail a Head of AI (ret-ai-l).
 */
export function titleMatches(title: string | null | undefined, wanted: string): boolean {
  const want = titleWords(wanted);
  if (want.length === 0) return false;
  const have = new Set(titleWords(title ?? ""));
  return want.every((w) => have.has(w));
}

/**
 * People search results ordered by `jobTitles`: a title matching an earlier
 * entry first (every word of the entry in the title), unmatched last, and a
 * database work email breaking ties. Nameless results are dropped.
 */
export function rankByTitles(people: PersonResult[], jobTitles: string[]): PersonResult[] {
  const rank = (p: PersonResult): number => {
    const i = jobTitles.findIndex((wanted) => titleMatches(p.title, wanted));
    return i === -1 ? jobTitles.length : i;
  };
  return people
    .filter((p) => personName(p) !== null)
    .map((p, i) => ({ p, i, r: rank(p), e: p.best_work_email ? 0 : 1 }))
    .toSorted((a, b) => a.r - b.r || a.e - b.e || a.i - b.i)
    .map((x) => x.p);
}

/**
 * The company's decision owner. With `jobTitles`, one title-scoped people
 * search ($0.01) and up to three candidates through the contact spine until
 * one passes the person gate; without, the spine's own domain-only pick.
 *
 * Only people whose title matches a wanted one are tried. The search's own
 * title filter is loose (measured 2026-10-11: five AI titles at a bank's
 * domain returned 25 senior people, none in AI), and paying to qualify a
 * Head of Communications ends in a role rejection every time.
 */
async function findOwner(args: {
  opts: ListPageOpts;
  domain: string;
  companyName: string;
  evidence: string;
  icp: string | null;
  isDup: (email: string) => boolean;
}): Promise<{ contact: QualifiedContact | null; costUsd: number; noMatch: boolean }> {
  const { opts, domain, companyName, evidence, icp } = args;
  const jobTitles = (opts.jobTitles ?? []).map((t) => t.trim()).filter(Boolean);
  const base = {
    playName: PLAY_NAME,
    companyDomain: domain,
    isDuplicate: args.isDup,
    icp,
    fillGaps: opts.qualifyFillGaps ?? true,
    errKindPrefix: "list-page",
  };
  if (jobTitles.length === 0) {
    const contact = await resolveVerifyEnrichQualify({
      ...base,
      fullName: null,
      allowMissingFullName: true,
      person: { name: null, company: companyName, roleText: null, evidence },
    });
    return { contact, costUsd: contact.costUsd, noMatch: false };
  }
  const search = await safePeopleSearch(
    { companyDomains: [domain], jobTitles, limit: 25 },
    { playName: PLAY_NAME },
  );
  let costUsd = search.result.cost ?? 0;
  if (search.result.status === "error") return { contact: null, costUsd, noMatch: false };
  const ranked = rankByTitles((search.result.results ?? []) as PersonResult[], jobTitles).filter(
    (p) => jobTitles.some((wanted) => titleMatches(p.title, wanted)),
  );
  if (ranked.length === 0) return { contact: null, costUsd, noMatch: true };
  let last: QualifiedContact | null = null;
  for (const person of ranked.slice(0, MAX_OWNER_ATTEMPTS)) {
    const name = personName(person)!;
    const contact = await resolveVerifyEnrichQualify({
      ...base,
      fullName: name,
      knownEmail: person.best_work_email?.trim() || null,
      linkedinUrlHint: person.linkedin_url ?? null,
      titleHint: person.title ?? null,
      person: { name, company: companyName, roleText: person.title ?? null, evidence },
    });
    costUsd += contact.costUsd;
    last = contact;
    // Only a role verdict is worth another candidate; a duplicate or a
    // platform error would repeat for the next one too.
    if (contact.ok || contact.reason !== "role") break;
  }
  return { contact: last, costUsd, noMatch: false };
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
  const jobTitles = (opts.jobTitles ?? []).map((t) => t.trim()).filter(Boolean);
  // Order ranks candidates but does not change who matches: sort for the key.
  const titlesHash = createHash("sha256")
    .update(JSON.stringify(jobTitles.map((t) => t.toLowerCase()).toSorted()))
    .digest("hex");
  /** Where a company with no one matching these titles is remembered for a while. */
  const missKey = (dedupeKey: string): string =>
    `list-page-miss:${dedupeKey}:${titlesHash.slice(0, 12)}`;

  // Read every list first, keeping the companies still to work: not queued
  // already, not named by an earlier list, and not a recent title miss. All
  // of that is free, so none of it counts toward the limit.
  interface Pending {
    source: ListPageSource;
    rowSource: string;
    company: ListPageCompany;
    dedupeKey: string;
  }
  const bySource = new Map<string, Pending[]>();
  const claimed = new Set<string>();
  for (const [index, source] of opts.sources.entries()) {
    // A page that needs rendering is a paid read: the cap holds here too.
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    const rowSource = `${SOURCE}:${slugify(source.signal)}`;
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

    const pending: Pending[] = [];
    for (const company of companies) {
      const dedupeKey = `list-page:${company.domain ?? `name:${slugify(company.name)}`}`;
      if (
        claimed.has(dedupeKey) ||
        dedupeScope.some((p) => ledger.isQueueDuplicate(p, dedupeKey))
      ) {
        result.droppedDuplicate++;
        continue;
      }
      claimed.add(dedupeKey);
      if (
        jobTitles.length > 0 &&
        ledger.getProductResearchCache(missKey(dedupeKey), TITLE_MISS_TTL_MS)
      ) {
        result.droppedDuplicate++;
        continue;
      }
      pending.push({ source, rowSource, company, dedupeKey });
    }
    bySource.set(`${index}:${source.url}`, pending);
  }

  // One company from each list in turn, so a run draws from every list
  // instead of finishing the first before the second starts.
  const total = [...bySource.values()].reduce((n, list) => n + list.length, 0);
  let worked = 0;
  for (const { source, rowSource, company, dedupeKey } of roundRobin(bySource, total)) {
    if (worked >= limit) {
      result.halted = `limit (${limit})`;
      return result;
    }
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      return result;
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

    let verified: { status: "confirmed" | "unconfirmed"; url?: string } | null = null;
    if (source.verify) {
      const check = await verifySignal({ company: company.name, domain, verify: source.verify });
      result.costUsd += check.costUsd;
      if (check.verdict === "absent") {
        // The company's own subprocessor list leaves the vendor out: a
        // verdict on the company, recorded once like a role miss.
        result.droppedLowSignal = (result.droppedLowSignal ?? 0) + 1;
        persistRoleRejection({
          playName: PLAY_NAME,
          dedupeKey,
          payload: { company: company.name, signal: source.signal },
          source: rowSource,
          kind: "signal",
          reason: `${check.url} lists subprocessors without ${source.verify.names.join(" / ")}`,
          dryRun: opts.dryRun,
        });
        continue;
      }
      verified =
        check.verdict === "confirmed"
          ? { status: "confirmed", ...(check.url ? { url: check.url } : {}) }
          : { status: "unconfirmed" };
    }

    const evidence = company.context ? `${source.signal}: ${company.context}` : source.signal;
    const found = await findOwner({
      opts,
      domain,
      companyName: company.name,
      evidence,
      icp,
      isDup: (email) => isDuplicate({ playName: dedupeScope, dedupeKey, prospectEmail: email }),
    });
    result.costUsd += found.costUsd;
    const contact = found.contact;
    if (!contact || !contact.ok) {
      const reason = contact ? contact.reason : found.noMatch ? "no-match" : "platform-error";
      if (reason === "duplicate") result.droppedDuplicate++;
      else if (reason === "no-match") {
        // No one with a wanted title at this company today. Remembered for a
        // while, not rejected: a rejected row would keep the company out for
        // good on the strength of one search.
        result.droppedRole = (result.droppedRole ?? 0) + 1;
        ledger.setProductResearchCache(
          missKey(dedupeKey),
          JSON.stringify({ domain, at: new Date().toISOString() }),
        );
      } else if (reason === "role") {
        // A verdict on the company's best match, not a hiccup: record it once
        // so later runs move on down the list instead of paying for it again.
        result.droppedRole = (result.droppedRole ?? 0) + 1;
        persistRoleRejection({
          playName: PLAY_NAME,
          dedupeKey,
          payload: { company: company.name, signal: source.signal },
          source: rowSource,
          reason: (contact && !contact.ok ? contact.detail : null) ?? "off-ICP role",
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
      ...(verified ? { signalVerified: verified.status } : {}),
      ...(verified?.url ? { signalEvidenceUrl: verified.url } : {}),
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
  return result;
}
