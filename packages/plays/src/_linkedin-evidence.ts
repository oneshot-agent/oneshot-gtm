import {
  FREEMAIL_DOMAINS,
  getLedger,
  readPaidCache,
  readPersonHalf,
  demoDayOf,
  type LinkedInOperation,
  withPaidCache,
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

// These patterns run on text a prospect or an event host wrote. None has an
// open-ended quantifier next to another one, so each is linear in the input;
// the cut is taken at the first match and the rest is dropped by slicing.
const SUBTITLE_RX = /\s[–—|]\s|\s-\s|:\s/u;
const COHOST_RX = /\s(?:[x×]|co-?hosted by|hosted by|presented by|in partnership with|w\/)\s/iu;
const COHOST_PAREN_RX = /^\((?:co-?hosted|hosted|presented)[^)]*\)$/iu;
const LEADING_ARTICLE_RX = /^(?:the|a|an)\s/i;

function cutAt(text: string, rx: RegExp): string {
  const at = text.search(rx);
  return at < 0 ? text : text.slice(0, at);
}

function trimEndChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** An event title as it reads in a sentence: no subtitle, no co-host credit, no leading article. */
export function tidyEventTitle(title: string): string {
  let out = cutAt(cutAt(title.trim(), SUBTITLE_RX), COHOST_RX).trim();
  if (out.endsWith(")")) {
    const open = out.lastIndexOf("(");
    if (open >= 0 && COHOST_PAREN_RX.test(out.slice(open))) out = out.slice(0, open).trim();
  }
  return out.replace(LEADING_ARTICLE_RX, "").trim();
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function listOf(value: string): string {
  const items = value
    .split(/,|;|\/|\||\band\b|&/i)
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
const BATCH_TAG_RX = /\s?\(?\s?yc\s?[wspxf]\d{2}\s?\)?/gi;
const LEGAL_SUFFIX_RX =
  /[,\s]{1,4}(?:llc|l\.l\.c\.?|inc\.?|incorporated|ltd\.?|limited|gmbh|ab|s\.l\.?|sl|corp\.?|corporation|plc|bv|b\.v\.?|sas|ag|oy|pty|co\.?)$/i;

/** A company name as it is said: no batch tag, no legal suffix. Empty for a name that never counts. */
export function tidyCompanyName(name: string | null | undefined): string {
  let out = (name ?? "").replace(BATCH_TAG_RX, "").trim();
  for (let i = 0; i < 3; i++) out = out.replace(LEGAL_SUFFIX_RX, "").trim();
  out = trimEndChars(out, ",. \t\r\n").trim();
  return !out || NEVER_A_COMPANY.test(out) ? "" : out;
}

const compactKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** The registrable label of a domain: `usesoren` for `usesoren.com`, `acme` for `acme.co.uk`. */
function domainLabel(domain: string): string | null {
  const host = cutAt(
    domain
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^.*@/, ""),
    /[/?#]/,
  ).replace(/^www\./, "");
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
    const before = trimEndChars(text.slice(0, m.index), " \t\r\n(@");
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

/** Reads a profile live (the connected account's silent profile view). */
export type LiveProfileReader = (url: string) => Promise<LiveProfileSnapshot | null>;

/** A remembered read is reused for a day, so a long-lived server does not keep one forever. */
const LIVE_MEMO_TTL_MS = DAY;
const liveReads = new Map<string, { read: Promise<LiveProfileSnapshot | null>; at: number }>();

/** Test hook: forget the reads made so far. */
export function _resetLinkedInLiveReads(): void {
  liveReads.clear();
}

/** A view OneShot has accepted and not finished: its job id, kept so a later call resumes it. */
const VIEW_PENDING_PREFIX = "linkedin-view-pending:";
/** A job id older than this is given up on, and the view is asked for again. */
const VIEW_PENDING_TTL_MS = DAY;
/** How long one call waits for a view before leaving it for the next call. */
const VIEW_WAIT_MS = 20_000;
const VIEW_POLL_PAUSE_MS = 1_000;
const IN_FLIGHT = new Set(["pending", "processing", "queued", "running"]);

function pendingView(key: string, now: number): string | null {
  try {
    const row = getLedger().getCachedEnrichment(VIEW_PENDING_PREFIX + key);
    if (!row || row.status === "failed") return null;
    if (now - new Date(row.fetched_at).getTime() >= VIEW_PENDING_TTL_MS) return null;
    const id = (JSON.parse(row.result_json) as { requestId?: unknown }).requestId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function keepPendingView(key: string, requestId: string): void {
  try {
    getLedger().setCachedEnrichment(VIEW_PENDING_PREFIX + key, JSON.stringify({ requestId }));
  } catch {
    // without the id the next call asks again under the same idempotency key
  }
}

function dropPendingView(key: string): void {
  try {
    if (getLedger().getCachedEnrichment(VIEW_PENDING_PREFIX + key))
      getLedger().setCachedEnrichmentFailure(VIEW_PENDING_PREFIX + key, "settled");
  } catch {
    // a stale id expires on its own
  }
}

function record(node: unknown): Record<string, unknown> | null {
  return node && typeof node === "object" && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : null;
}

/**
 * A reader over OneShot's `profile` operation (a silent view, `notify: false`).
 * The idempotency key is stable per person and play, so a retry is not billed twice.
 *
 * The view is asynchronous: the first answer is usually an acceptance with a
 * job id and no profile. That is not a read. The job id is kept, the job is
 * waited on for a short while, and only a finished view that carries a profile
 * becomes a snapshot. An unfinished one answers null, and the next call for the
 * same person and play resumes the same job instead of paying for another view.
 */
export function profileViewReader(input: {
  call: (operation: LinkedInOperation) => Promise<unknown>;
  accountId: string;
  idempotencyKey: string;
  /** Test hooks; the defaults wait up to 20 seconds, a second between checks. */
  waitMs?: number;
  pauseMs?: number;
}): LiveProfileReader {
  const key = input.idempotencyKey;
  return async (url) => {
    const deadline = Date.now() + (input.waitMs ?? VIEW_WAIT_MS);
    let requestId = pendingView(key, Date.now());
    let done: Record<string, unknown> | null = null;
    for (;;) {
      let answer: Record<string, unknown> | null;
      try {
        answer = record(
          await input.call(
            requestId
              ? { kind: "wait", requestId }
              : {
                  kind: "profile",
                  accountId: input.accountId,
                  identifier: url,
                  idempotencyKey: key,
                },
          ),
        );
      } catch (err) {
        // `wait` gives up after two seconds on a job that is still running.
        if (!requestId || (err as { name?: unknown }).name !== "JobTimeoutError") {
          if (requestId) dropPendingView(key);
          throw err;
        }
        if (Date.now() >= deadline) return null;
        continue;
      }
      const status = String(answer?.["status"] ?? "");
      if (!IN_FLIGHT.has(status)) {
        dropPendingView(key);
        if (status === "failed" || status === "error") return null;
        done = record(answer?.["result"]) ?? answer;
        break;
      }
      const accepted = answer?.["request_id"];
      if (typeof accepted === "string" && accepted && accepted !== requestId) {
        requestId = accepted;
        keepPendingView(key, accepted);
      }
      // Accepted with nothing to resume by: not a read, and nothing to wait on.
      if (!requestId || Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, input.pauseMs ?? VIEW_POLL_PAUSE_MS));
    }
    // A finished view carries the profile; an answer without one is not evidence.
    if (!record(done?.["profile"])) return null;
    const headline = findString(done, ["headline"]);
    const company = findString(done, ["current_company", "company_name"]);
    return {
      ...(headline ? { headline } : {}),
      experience: company ? [{ company, period: "Present" }] : [],
    };
  };
}

/** A stored read as the snapshot the note and messages use: headline and Experience list. */
function snapshotFrom(value: unknown): LiveProfileSnapshot | null {
  const p = record(value);
  if (!p) return null;
  const experience = (Array.isArray(p["experience"]) ? p["experience"] : [])
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
  const headline = p["headline"];
  return {
    ...(typeof headline === "string" && headline ? { headline } : {}),
    experience,
  };
}

/**
 * A read already bought for this profile, in the paid cache: person
 * research's full read first, else an earlier silent view.
 */
function storedLiveProfile(url: string, now: Date): LiveProfileSnapshot | null {
  for (const callType of ["linkedin.profile_read", "linkedin.profile"] as const) {
    const entry = readPaidCache(callType, { url }, { now: now.getTime() });
    if (entry?.status !== "ok") continue;
    const snapshot = snapshotFrom(entry.result);
    if (snapshot) return snapshot;
  }
  return null;
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
  if (memo && now.getTime() - memo.at < LIVE_MEMO_TTL_MS) return memo.read;
  // Only a snapshot is remembered. A missing reader (a batch preview passes
  // none) or a failed read is not: the next caller with a reader tries again.
  const forget = () => {
    if (liveReads.get(key)?.read === read) liveReads.delete(key);
  };
  const read: Promise<LiveProfileSnapshot | null> = (async () => {
    const stored = storedLiveProfile(url, now);
    if (stored) return stored;
    if (!reader) return null;
    try {
      // The paid cache keeps a finished view for the cadence's later steps,
      // across runs and workspaces; a view that did not finish is not kept.
      const out = await withPaidCache("linkedin.profile", { url }, undefined, async () => ({
        result: await reader(url),
        receiptId: 0,
      }));
      return snapshotFrom(out.result);
    } catch {
      return null;
    }
  })();
  liveReads.set(key, { read, at: now.getTime() });
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
    // The stored headline corroborates like a domain does ("Founder at Soren"
    // on a personal mailbox); the live read below still has to agree.
    headline: findString(half, ["headline"]),
  };
  // Cheap checks first: no live read is made for someone who fails the stored ones.
  if (!storedFounderCompany(facts)) return null;
  const url = prospect.linkedin_url;
  const live = await liveProfileFor(`${input.playName}|${url ?? ""}`, url, input.reader, input.now);
  // The stored check keeps the stored headline; the live read is judged on its
  // own headline and current position, so a live headline that says something
  // else does not undo a company the live position names.
  return verifiedFounderCompany(facts, live);
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

/** `max` is the note's own limit; it never loosens the hard ceiling. */
export function lintLinkedInNote(note: string, max = LINKEDIN_NOTE_LINT_MAX): string[] {
  const flags: string[] = [];
  const limit = Math.min(max, LINKEDIN_NOTE_LINT_MAX);
  if (note.length > limit) flags.push(`note-too-long: ${note.length}/${limit} characters`);
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

/**
 * The framing an already-connected reader must not get: thanks for connecting,
 * a request, an invite, an acceptance, or "glad we connected". Each pattern names
 * the social connection, not the verb: these messages talk about products that
 * connect things, and "we connect agents to your tools" is not a violation.
 */
const ALREADY_CONNECTED_RX: ReadonlyArray<[label: string, rx: RegExp]> = [
  ["thanks for connecting", /\bthank(?:s|\s+you)\b[^.?!\n]{0,30}\b(?:connect|accept)/i],
  ["connection request", /\bconnection\s+request/i],
  ["invite", /\b(?:an|my|the|your|our)\s+(?:invite|invitation)\b|\binvited\s+you\b/i],
  ["accepted", /\baccept(?:ed|ing)\s+(?:my|the|our)\s+(?:connection|invite|invitation|request)\b/i],
  [
    "glad we connected",
    /\b(?:glad|great|nice|good)\s+(?:we\s+)?(?:to\s+)?(?:be\s+)?connect(?:ed|ing)?\b/i,
  ],
];

/**
 * For a reader already connected before this sequence: no request was sent or
 * accepted, so the message may not thank them for connecting or mention one.
 * Applied on top of the first-message and close lints, only on that path.
 */
export function lintAlreadyConnected(text: string): string[] {
  return ALREADY_CONNECTED_RX.filter(([, rx]) => rx.test(text)).map(
    ([label]) => `already-connected: "${label}" — they were connected before this sequence`,
  );
}

const clean = (s: string) => s.trim().replace(/^"|"$/g, "");

const SAW_YOU_RX = /\b(?:saw|noticed|spotted|seen)\s+(?:that\s+)?you\b/gi;
// The checks below read model output. Whitespace is skipped by trimming, never
// by a quantifier next to another one, so each is linear in the input.
/** A word that may sit between "saw you" and the clause without claiming anything. */
const CLAIM_FILLER_RX = /^(?:recently|just|also|'ve|have|had)\b/i;
/** A word that may follow the clause without claiming anything. */
const CLAIM_TAIL_EXTRA_RX = /^(?:too|recently|on github)\b/i;
/** The writer turning to themselves ("so figured I'd ask"). */
const CLAIM_TURN_RX =
  /^(?:(?:and|so|which|that) )?(?:i|we|curious|figured|wanted|thought|wondered|had to|made me|got me)\b/i;

function skipFiller(text: string): string {
  let rest = text.trimStart();
  for (let m = CLAIM_FILLER_RX.exec(rest); m; m = CLAIM_FILLER_RX.exec(rest))
    rest = rest.slice(m[0].length).trimStart();
  return rest;
}

/**
 * What may follow the clause on its line: nothing, the end of the sentence, or
 * the writer turning to themselves. Anything else is a second thing said about
 * the reader.
 */
function tailSaysNothingMore(tail: string): boolean {
  let rest = cutAt(tail, /\n/).trimStart();
  const extra = CLAIM_TAIL_EXTRA_RX.exec(rest);
  if (extra) rest = rest.slice(extra[0].length).trimStart();
  if (!rest || ".?!".includes(rest[0]!)) return true;
  if (",;:–—-".includes(rest[0]!)) rest = rest.slice(1).trimStart();
  return CLAIM_TURN_RX.test(rest.replace(/\s/g, " "));
}

/**
 * The "saw you …" claims the evidence does not support. A claim is supported
 * when it says the aged evidence clause and nothing more about the reader:
 * naming the clause is not enough, since "saw you starred acme/widgets and
 * raised a Seed round" carries a second claim nothing backs. The clause is
 * matched where it stands, so one with a dot in it (a repo name) still counts.
 */
function unsupportedClaims(text: string, clause: string | undefined): string[] {
  const out: string[] = [];
  const want = clause?.toLowerCase();
  for (const m of text.matchAll(SAW_YOU_RX)) {
    const rest = text.slice(m.index + m[0].length);
    const said = skipFiller(rest);
    const supported =
      !!want && said.toLowerCase().startsWith(want) && tailSaysNothingMore(said.slice(want.length));
    if (!supported) out.push(`${m[0]}${cutAt(rest, /[.?!\n]/)}`);
  }
  return out;
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
  for (const claim of unsupportedClaims(text, ctx.clause)) {
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
