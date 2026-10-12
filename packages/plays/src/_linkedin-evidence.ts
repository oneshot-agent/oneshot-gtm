import {
  FREEMAIL_DOMAINS,
  getLedger,
  readPersonHalf,
  demoDayOf,
  type LinkedInOperation,
} from "@oneshot-gtm/core";
import { complete } from "@oneshot-gtm/intel";

/**
 * Prompt context for the LinkedIn note and messages (#790). Everything here is
 * a deterministic fact handed to the model as context it may use: nothing
 * prepends or wraps copy. Evidence is aged so a stale claim is dropped, a
 * company is named only when a live read of the profile agrees, and the output
 * is linted with one repair turn.
 */

const DAY = 86_400_000;

function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// Aged evidence
// ---------------------------------------------------------------------------

/** Longest clause that is ever passed on; a longer one is dropped, never cut. */
export const EVIDENCE_CLAUSE_MAX_CHARS = 80;

const SUBTITLE_RX = /\s+[–—|]\s+.*$|\s+-\s+.*$|:\s+.*$/u;
const COHOST_RX =
  /\s+(?:[x×]|co-?hosted by|hosted by|presented by|in partnership with|w\/)\s+.*$|\s*\((?:co-?hosted|hosted|presented)[^)]*\)\s*$/iu;
const LEADING_ARTICLE_RX = /^(?:the|a|an)\s+/i;

/** An event title as it reads in a sentence: no subtitle, no co-host credit, no leading article. */
export function tidyEventTitle(title: string): string {
  return title
    .trim()
    .replace(SUBTITLE_RX, "")
    .replace(COHOST_RX, "")
    .replace(LEADING_ARTICLE_RX, "")
    .trim();
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function listOf(value: string): string {
  const items = value
    .split(/\s*(?:,|;|\/|\||\band\b|&)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a");

function cohortLabel(cohort: string): string {
  const m = /^yc[-\s]?([wpxsf])(\d{2})$/i.exec(cohort.trim());
  return m ? `YC ${m[1]!.toUpperCase()}${m[2]}` : cohort.trim();
}

/** When a cohort ends (its demo day), or null when the schedule is unknown. */
function cohortEnd(meta: Record<string, unknown>, cohort: string, now: Date): Date | null {
  const day = demoDayOf(
    {
      cohort,
      ...(str(meta, "demoDayDate") ? { demoDayDate: str(meta, "demoDayDate") } : {}),
      ...(str(meta, "demoDayMonth") ? { demoDayMonth: str(meta, "demoDayMonth") } : {}),
    },
    now,
  );
  if (!day) return null;
  if (day.isoDate) return new Date(`${day.isoDate}T23:59:59Z`);
  const [y, m] = day.isoMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0, 23, 59, 59));
}

/**
 * One short clause for the play's first-touch evidence, true today, or
 * nothing. `contactedAt` is when the person was first contacted (the evidence
 * was current then); an evidence line that is too old, or too long to read as
 * a clause, is dropped rather than shortened.
 */
export function agedEvidence(
  metadata: Record<string, unknown>,
  opts: { contactedAt: Date; now: Date },
): string | undefined {
  const { contactedAt, now } = opts;
  const since = Math.floor((now.getTime() - contactedAt.getTime()) / DAY);
  const candidates: Array<string | null> = [];

  const repo = str(metadata, "repo");
  candidates.push(repo ? `starred ${repo}` : null);

  const eventTitle = str(metadata, "eventTitle");
  const eventDate = parseDate(str(metadata, "eventDate"));
  if (eventTitle && eventDate) {
    const name = tidyEventTitle(eventTitle);
    const ago = Math.floor((now.getTime() - eventDate.getTime()) / DAY);
    if (name) {
      if (eventDate.getTime() > now.getTime()) candidates.push(`signed up for ${name}`);
      else candidates.push(ago <= 45 ? `were at ${name}` : null);
    }
  }

  const stack = str(metadata, "vendorStack");
  if (stack && since <= 180) {
    const names = listOf(stack);
    if (names) candidates.push(since <= 45 ? `running ${names}` : `were running ${names}`);
  }

  const cohort = str(metadata, "prospectCohort");
  if (cohort) {
    const label = cohortLabel(cohort);
    const end = cohortEnd(metadata, cohort, now);
    const over = end ? now.getTime() - end.getTime() > 60 * DAY : false;
    candidates.push(over ? `went through ${label}` : `in ${label}`);
  }

  const round = str(metadata, "round");
  if (round && since <= 180) {
    const lead = str(metadata, "leadInvestor");
    candidates.push(
      lead
        ? `${lead} led your ${round}`
        : `${since <= 45 ? "just " : ""}raised ${article(round)} ${round}`,
    );
  }

  const newCompany = str(metadata, "newCompany");
  if (newCompany && since <= 90) {
    const role = str(metadata, "newRole");
    candidates.push(
      `${since <= 45 ? "just " : ""}joined ${newCompany}${role ? ` as ${role}` : ""}`,
    );
  }

  const job = str(metadata, "jobTitle");
  if (job && since <= 45) candidates.push(`hiring ${article(job)} ${job}`);

  return candidates.find(
    (c): c is string => c !== null && c.length > 0 && c.length <= EVIDENCE_CLAUSE_MAX_CHARS,
  );
}

// ---------------------------------------------------------------------------
// Reader role and the company they run
// ---------------------------------------------------------------------------

export type ReaderRole =
  | "founder"
  | "engineer"
  | "student"
  | "growth or operations"
  | "investor"
  | "unknown";

/** Founder / co-founder / founding / CEO / CTO / owner / chief … officer, as whole words. */
export function isFounderTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return /\b(?:founder|founding|ceo|cto|owner)\b|\bchief\b[^,;|]*?\bofficer\b/i.test(title);
}

/** The reader's role, from their title alone. */
export function readerRole(title: string | null | undefined): ReaderRole {
  const t = title?.trim() ?? "";
  if (!t) return "unknown";
  if (
    /\b(?:investor|venture|vc|angel|general partner|gp)\b|\bpartner\b.*\b(?:capital|ventures?|fund)\b/i.test(
      t,
    )
  )
    return "investor";
  if (/\b(?:student|intern|undergrad(?:uate)?|phd|graduate)\b/i.test(t)) return "student";
  if (/\b(?:founder|ceo|cto|owner)\b|\bchief\b[^,;|]*?\bofficer\b/i.test(t)) return "founder";
  if (/\b(?:engineer|developer|programmer|architect|devops|sre|swe)\b/i.test(t)) return "engineer";
  if (
    /\b(?:growth|marketing|sales|revenue|operations|ops|gtm|demand|partnerships|business development|customer success)\b/i.test(
      t,
    )
  )
    return "growth or operations";
  return "unknown";
}

const NEVER_A_COMPANY =
  /\b(?:stealth|self[- ]?employed|universit(?:y|ies)|school|program(?:me)?|fund)\b/i;
const BATCH_TAG_RX = /\s*\(?\s*yc\s*[wspxf]\d{2}\s*\)?/gi;
const LEGAL_SUFFIX_RX =
  /[,\s]+(?:llc|l\.l\.c\.?|inc\.?|incorporated|ltd\.?|limited|gmbh|ab|s\.l\.?|sl|corp\.?|corporation|plc|bv|b\.v\.?|sas|ag|oy|pty|co\.?)$/i;

/** A company name as it is said: no batch tag, no legal suffix. Empty for a name that never counts. */
export function tidyCompanyName(name: string | null | undefined): string {
  let out = (name ?? "").replace(BATCH_TAG_RX, "").trim();
  for (let i = 0; i < 3; i++) out = out.replace(LEGAL_SUFFIX_RX, "").trim();
  out = out.replace(/[,.\s]+$/u, "").trim();
  return !out || NEVER_A_COMPANY.test(out) ? "" : out;
}

const compactKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** The registrable label of a domain: `usesoren` for `usesoren.com`, `acme` for `acme.co.uk`. */
function domainLabel(domain: string): string | null {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const n = labels.length;
  const idx =
    n >= 3 && SECOND_LEVEL.has(labels[n - 2]!) && labels[n - 1]!.length === 2 ? n - 3 : n - 2;
  return labels[idx]?.replace(/[^a-z0-9]/g, "") || null;
}

/** A domain stands for a company: same label, or the label prefixes/suffixes the name (3+ characters). */
export function domainMatchesCompany(domain: string | null | undefined, company: string): boolean {
  if (!domain) return false;
  const host = domain.trim().toLowerCase().replace(/^.*@/, "");
  if (FREEMAIL_DOMAINS.has(host) || /(?:^|\.)(?:edu|ac\.[a-z]{2})$/.test(host)) return false;
  const label = domainLabel(domain);
  const key = compactKey(tidyCompanyName(company));
  if (!label || !key) return false;
  if (label === key) return true;
  if (key.length < 3) return false;
  return label.startsWith(key) || label.endsWith(key);
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The company named as whole words in `text`, other than after ex-/former/prev. */
export function mentionsCompany(text: string | null | undefined, company: string): boolean {
  const name = tidyCompanyName(company);
  if (!text || !name) return false;
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRx(name)}(?![\\p{L}\\p{N}])`, "giu");
  for (const m of text.matchAll(rx)) {
    const before = text.slice(0, m.index).replace(/[\s(@]+$/u, "");
    if (/(?:\bex|\bformer(?:ly)?|\bprev(?:ious(?:ly)?)?\.?)[-\s]*$/i.test(before)) continue;
    return true;
  }
  return false;
}

/** What a live read of the profile shows. */
export interface LiveProfileSnapshot {
  headline?: string;
  experience: Array<{ company: string; title?: string; period?: string }>;
}

/** Whether a live read names `company` in its headline or a current position. */
export function liveProfileNames(live: LiveProfileSnapshot | null, company: string): boolean {
  if (!live) return false;
  if (mentionsCompany(live.headline, company)) return true;
  const key = compactKey(tidyCompanyName(company));
  if (!key) return false;
  return live.experience.some(
    (e) =>
      /\b(?:present|current)\b/i.test(e.period ?? "") &&
      (compactKey(tidyCompanyName(e.company)) === key || mentionsCompany(e.company, company)),
  );
}

export interface FounderCompanyFacts {
  title: string | null;
  dossierTitle?: string | null;
  company: string | null;
  email: string | null;
  dossierDomain?: string | null;
  headline?: string | null;
}

/**
 * The company a founder runs, as stored: a founder title and one corroboration
 * (work-email domain, dossier domain, or a current mention in title/headline).
 * Not enough on its own to name the company: see `companyTheyRun`.
 */
export function storedFounderCompany(f: FounderCompanyFacts): string | null {
  const title = f.title?.trim() || f.dossierTitle?.trim() || null;
  if (!isFounderTitle(title)) return null;
  const company = tidyCompanyName(f.company);
  if (!company) return null;
  const emailDomain = f.email?.includes("@") ? f.email.slice(f.email.indexOf("@") + 1) : null;
  const corroborated =
    domainMatchesCompany(emailDomain, company) ||
    domainMatchesCompany(f.dossierDomain, company) ||
    mentionsCompany(title, company) ||
    mentionsCompany(f.headline, company);
  return corroborated ? company : null;
}

/** The company the live read names, or null. Pure counterpart of `companyTheyRun`. */
export function verifiedFounderCompany(
  facts: FounderCompanyFacts,
  live: LiveProfileSnapshot | null,
): string | null {
  const company = storedFounderCompany(facts);
  return company && liveProfileNames(live, company) ? company : null;
}

// ---------------------------------------------------------------------------
// Live read (once per prospect per cadence)
// ---------------------------------------------------------------------------

const LIVE_CACHE_PREFIX = "linkedin-profile:";
const LIVE_CACHE_TTL_MS = 30 * DAY;

/** Reads a profile live (the connected account's silent profile view). */
export type LiveProfileReader = (url: string) => Promise<LiveProfileSnapshot | null>;

const liveReads = new Map<string, Promise<LiveProfileSnapshot | null>>();

/** Test hook: forget the reads made so far. */
export function _resetLinkedInLiveReads(): void {
  liveReads.clear();
}

/**
 * A reader over OneShot's `profile` operation (a silent view, `notify: false`).
 * The idempotency key is stable per person and play, so a retry is not billed twice.
 */
export function profileViewReader(input: {
  call: (operation: LinkedInOperation) => Promise<unknown>;
  accountId: string;
  idempotencyKey: string;
}): LiveProfileReader {
  return async (url) => {
    const result = await input.call({
      kind: "profile",
      accountId: input.accountId,
      identifier: url,
      idempotencyKey: input.idempotencyKey,
    });
    const headline = findString(result, ["headline"]);
    const company = findString(result, ["current_company", "company_name"]);
    return {
      ...(headline ? { headline } : {}),
      experience: company ? [{ company, period: "Present" }] : [],
    };
  };
}

// Same normalisation as the stored read's cache key (packages/find/src/_linkedin-profile.ts).
function liveCacheKey(value: string): string {
  let norm = value.trim().toLowerCase();
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    norm = url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    // keep the trimmed value
  }
  return `${LIVE_CACHE_PREFIX}${norm}`;
}

/** Where a silent profile view is kept, so the cadence's later steps reuse it across runs. */
const VIEW_CACHE_PREFIX = "linkedin-view:";

function storedLiveProfile(url: string, now: Date): LiveProfileSnapshot | null {
  const key = liveCacheKey(url);
  return (
    readStored(key, now) ?? readStored(VIEW_CACHE_PREFIX + key.slice(LIVE_CACHE_PREFIX.length), now)
  );
}

function readStored(key: string, now: Date): LiveProfileSnapshot | null {
  try {
    const cached = getLedger().getCachedEnrichment(key);
    if (!cached || cached.status === "failed") return null;
    if (now.getTime() - new Date(cached.fetched_at).getTime() >= LIVE_CACHE_TTL_MS) return null;
    const p = JSON.parse(cached.result_json) as {
      headline?: unknown;
      experience?: unknown;
    };
    const experience = (Array.isArray(p.experience) ? p.experience : [])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => {
        const item: { company: string; title?: string; period?: string } = {
          company: typeof e["company"] === "string" ? e["company"] : "",
        };
        if (typeof e["title"] === "string") item.title = e["title"];
        if (typeof e["period"] === "string") item.period = e["period"];
        return item;
      })
      .filter((e) => e.company);
    return {
      ...(typeof p.headline === "string" && p.headline ? { headline: p.headline } : {}),
      experience,
    };
  } catch {
    return null;
  }
}

/**
 * The live profile read for one person on one play: a stored read, else one
 * call to the registered reader. Made at most once per person per cadence in
 * this process and reused by the note and both messages.
 */
export function liveProfileFor(
  key: string,
  url: string | null,
  reader: LiveProfileReader | null | undefined,
  now: Date = new Date(),
): Promise<LiveProfileSnapshot | null> {
  if (!url) return Promise.resolve(null);
  const memo = liveReads.get(key);
  if (memo) return memo;
  // Only a snapshot is remembered. A missing reader (a batch preview passes
  // none) or a failed read is not: the next caller with a reader tries again.
  const forget = () => {
    if (liveReads.get(key) === read) liveReads.delete(key);
  };
  const read: Promise<LiveProfileSnapshot | null> = (async () => {
    const stored = storedLiveProfile(url, now);
    if (stored) return stored;
    if (!reader) return null;
    try {
      const snapshot = await reader(url);
      if (snapshot) {
        try {
          getLedger().setCachedEnrichment(
            VIEW_CACHE_PREFIX + liveCacheKey(url).slice(LIVE_CACHE_PREFIX.length),
            JSON.stringify(snapshot),
          );
        } catch {
          // the in-process memo still holds
        }
      }
      return snapshot;
    } catch {
      return null;
    }
  })();
  liveReads.set(key, read);
  void read.then((snapshot) => {
    if (!snapshot) forget();
  }, forget);
  return read;
}

function findString(node: unknown, keys: readonly string[], depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 3) return null;
  const rec = node as Record<string, unknown>;
  for (const k of keys) {
    if (typeof rec[k] === "string" && (rec[k] as string).trim()) return (rec[k] as string).trim();
  }
  for (const k of ["profile", "enrichment", "company"]) {
    const found = findString(rec[k], keys, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The company this person runs, to name in a question: only when their title
 * is a founder's, stored data corroborates the company, AND a live read of
 * their LinkedIn profile names it. Null otherwise: stored data alone is never
 * enough.
 */
export async function companyTheyRun(input: {
  playName: string;
  prospect: {
    title: string | null;
    company: string | null;
    email: string | null;
    linkedin_url: string | null;
    dossier_json: string | null;
  };
  reader?: LiveProfileReader | null | undefined;
  now?: Date;
}): Promise<string | null> {
  const { prospect } = input;
  const half = readPersonHalf(prospect.dossier_json);
  const dossierTitle = findString(half, ["title"]);
  const dossierDomain = findString(half, ["company_domain", "companyDomain"]);
  const dossierCompany = findString(half, ["company"]);
  const company = prospect.company?.trim() || dossierCompany;
  const facts: FounderCompanyFacts = {
    title: prospect.title,
    dossierTitle,
    company,
    email: prospect.email,
    dossierDomain,
  };
  // Cheap checks first: no live read is made for someone who fails the stored ones.
  if (!storedFounderCompany(facts)) return null;
  const url = prospect.linkedin_url;
  const live = await liveProfileFor(`${input.playName}|${url ?? ""}`, url, input.reader, input.now);
  return verifiedFounderCompany({ ...facts, headline: live?.headline ?? null }, live);
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export const LINKEDIN_NOTE_LINT_MAX = 300;
export const LINKEDIN_MESSAGE_LINT_MAX = 400;

const LINK_RX = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|ai|dev|co|app|org|net|so|xyz|sh)\b/i;
const NOTE_PITCH_RX =
  /\bi help (?:\w+\s+){0,2}(?:like|get|with)\b|\bwe (?:built|help|make)\b|\b(?:15|fifteen|20|30)[- ]?min(?:ute)?s?\b|\bquick (?:call|chat)\b|\bcan i show you\b/i;
const MEETING_ASK_RX =
  /\b(?:quick|short|brief|\d+[- ]?min(?:ute)?)\s+(?:call|chat|sync|demo)\b|\b(?:book|schedule|set up|grab|hop on|jump on|get on)\b[^.?!]*\b(?:call|meeting|time|demo|chat)\b|\bcalendly\b|\bcalendar\b|\bdemo\b|\bmeeting\b/i;
const PRICE_RX =
  /[$€£]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|euros?|bucks)\b|\bpric(?:e|es|ing)\b|\bper (?:month|seat|user)\b|\/(?:mo|month|yr|year)\b|\bfree trial\b/i;

function questionCount(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

export function lintLinkedInNote(note: string): string[] {
  const flags: string[] = [];
  if (note.length > LINKEDIN_NOTE_LINT_MAX)
    flags.push(`note-too-long: ${note.length}/${LINKEDIN_NOTE_LINT_MAX} characters`);
  if (NOTE_PITCH_RX.test(note)) flags.push("note-pitch: no pitch phrases in a connection note");
  if (LINK_RX.test(note)) flags.push("note-link: no link in a connection note");
  return flags;
}

export function lintLinkedInFirstMessage(
  text: string,
  ctx: { clause?: string | undefined } = {},
): string[] {
  const flags: string[] = [];
  if (text.length > LINKEDIN_MESSAGE_LINT_MAX)
    flags.push(`too-long: ${text.length}/${LINKEDIN_MESSAGE_LINT_MAX} characters`);
  const questions = questionCount(text);
  if (questions !== 1) flags.push(`questions: ${questions} question marks, exactly one wanted`);
  // The evidence clause is GTM's own words ("were at X Demo Day"), not a meeting ask.
  const asked = ctx.clause ? text.split(ctx.clause).join(" ") : text;
  if (MEETING_ASK_RX.test(asked)) flags.push("meeting-ask: no meeting ask in the first message");
  if (LINK_RX.test(text)) flags.push("link: no link in the first message");
  return flags;
}

const clean = (s: string) => s.trim().replace(/^"|"$/g, "");

/** The "saw you …" claims in a text: each must be the aged evidence clause. */
function sawYouClaims(text: string): string[] {
  return [...text.matchAll(/\b(?:saw|noticed|spotted|seen)\s+(?:that\s+)?you\b[^.?!\n]*/gi)].map(
    (m) => m[0],
  );
}

export function lintLinkedInClose(
  text: string,
  ctx: { context: string; clause?: string | undefined },
): string[] {
  const flags: string[] = [];
  if (text.length > LINKEDIN_MESSAGE_LINT_MAX)
    flags.push(`too-long: ${text.length}/${LINKEDIN_MESSAGE_LINT_MAX} characters`);
  if (LINK_RX.test(text)) flags.push("link: no link in the close");
  if (PRICE_RX.test(text)) flags.push("price: no price in the close");
  const known = new Set(ctx.context.match(/\d+/g) ?? []);
  const invented = (text.match(/\d+/g) ?? []).filter((d) => !known.has(d));
  if (invented.length > 0)
    flags.push(`invented-number: ${[...new Set(invented)].join(", ")} is not in the context`);
  const clause = ctx.clause?.toLowerCase();
  for (const claim of sawYouClaims(text)) {
    if (!clause || !claim.toLowerCase().includes(clause))
      flags.push(`unsupported-claim: "${claim.slice(0, 60)}" is not the evidence clause`);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Draft with one repair turn
// ---------------------------------------------------------------------------

export interface LintedDraft {
  text: string;
  /** Flags left after the repair turn; empty when the draft passes. */
  flags: string[];
}

/**
 * Draft, lint, and when the lint fails ask once more with the findings. The
 * repaired text is linted again; whatever flags remain are returned with it,
 * never hidden.
 */
export async function draftWithRepair(input: {
  /** The loaded system prompt (callers load it by literal name). */
  system: string;
  context: string;
  lint: (text: string) => string[];
  maxTokens: number;
  temperature?: number;
}): Promise<LintedDraft> {
  const messages = [
    { role: "system" as const, content: input.system },
    { role: "user" as const, content: input.context },
  ];
  const first = await complete({
    messages,
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens,
  });
  const text = clean(first.content);
  const flags = text ? input.lint(text) : [];
  if (!text || flags.length === 0) return { text, flags };
  const second = await complete({
    messages: [
      ...messages,
      { role: "assistant" as const, content: text },
      {
        role: "user" as const,
        content: `That draft broke these rules:\n${flags.map((f) => `- ${f}`).join("\n")}\nWrite it again so none are broken. Output ONLY the text.`,
      },
    ],
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens,
  });
  const repaired = clean(second.content);
  return repaired ? { text: repaired, flags: input.lint(repaired) } : { text, flags };
}
