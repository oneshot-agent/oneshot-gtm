import { getLedger, logEvent } from "@oneshot-gtm/core";
import { isDuplicate } from "./_dedupe.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistPending, registerPendingRetry } from "./_pending.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "gov-solicitation";
const SOURCE = "find:gov-solicitation";
const SAM_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search";
const REQUEST_TIMEOUT_MS = 15_000;
const DESCRIPTION_TIMEOUT_MS = 10_000;
/** SAM.gov's own ceiling: postedFrom/postedTo may span at most one year. */
const MAX_WINDOW_DAYS = 365;
/** Sane cap on results pulled per NAICS code per run. */
const RESULTS_PER_NAICS = 100;

export interface GovSolicitationFinderOpts extends RunOpts {
  /** 6-digit NAICS codes to scan. REQUIRED via readiness gate. */
  naics?: string[];
  /**
   * SAM.gov `ptype` codes. Default `["r","p"]` — Sources Sought + Presolicitation,
   * the window where the requirement is still being written.
   */
  noticeTypes?: string[];
  /** Optional agency-name substrings (case-insensitive) to keep — client-side filter. */
  agencies?: string[];
  /** Look-back window in days for `postedFrom`. Default 30; clamped to 365 (SAM.gov's own cap). */
  sinceDays?: number;
  /** Founder's one-line angle, threaded to the play. REQUIRED via readiness gate. */
  yourEdge?: string;
}

interface SamPointOfContact {
  type?: string | null;
  title?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface SamOpportunity {
  noticeId: string;
  title: string;
  solicitationNumber?: string | null;
  fullParentPathName?: string | null;
  postedDate?: string | null;
  type?: string | null;
  baseType?: string | null;
  naicsCode?: string | null;
  responseDeadLine?: string | null;
  pointOfContact?: SamPointOfContact[] | null;
  description?: string | null;
  uiLink?: string | null;
}

interface SamSearchResponse {
  totalRecords?: number;
  opportunitiesData?: SamOpportunity[];
}

/** MM/dd/yyyy — the exact format SAM.gov's v2 search requires. */
function formatSamDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** True for a notice type name naming a sources-sought or presolicitation window. */
export function isPreSolicitationType(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  return /sources\s*sought|presolicitation|pre-solicitation/i.test(typeName);
}

/**
 * Fetch one page of opportunities for a single NAICS code. Returns `null`
 * (never throws) on a non-2xx response or network failure — a per-NAICS
 * failure must not kill the whole run; the caller logs and moves on.
 */
async function fetchOpportunitiesForNaics(args: {
  apiKey: string;
  naics: string;
  ptype: string;
  postedFrom: string;
  postedTo: string;
}): Promise<SamOpportunity[] | null> {
  const url =
    `${SAM_SEARCH_URL}?api_key=${encodeURIComponent(args.apiKey)}` +
    `&postedFrom=${encodeURIComponent(args.postedFrom)}&postedTo=${encodeURIComponent(args.postedTo)}` +
    `&ptype=${encodeURIComponent(args.ptype)}&ncode=${encodeURIComponent(args.naics)}` +
    `&limit=${RESULTS_PER_NAICS}&offset=0`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logEvent(
        "error.swallowed",
        { kind: "gov-solicitation.search_status", naics: args.naics, status: res.status },
        "warn",
      );
      return null;
    }
    const data = (await res.json()) as SamSearchResponse;
    return Array.isArray(data.opportunitiesData) ? data.opportunitiesData : [];
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "gov-solicitation.search_fetch",
        naics: args.naics,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

/** Outcome of fetching a notice's full description body. */
type DescriptionOutcome = { ok: true; text: string | null } | { ok: false; transient: boolean };

/**
 * The notice's `description` field is a LINK, not the body — a second raw
 * HTTP GET (no OneShot SDK involved, so this costs nothing) against SAM.gov's
 * own API. A network blip / 5xx / timeout here is a genuine platform error
 * worth retrying (the RFP text is what lets the founder judge fit — enqueuing
 * without it rushes a decision this pre-PMF-only window doesn't get twice); a
 * 404 (deleted notice, or "Description Not Found") is a real negative, so the
 * candidate still enqueues with an empty description rather than looping
 * forever on a link that will never resolve.
 */
async function fetchDescription(url: string, apiKey: string): Promise<DescriptionOutcome> {
  // Guard the credentialed request: `url` is SAM.gov's own `description`
  // field on the search response, but it's still external, response-shaped
  // data. Require https + the exact SAM.gov API host before attaching
  // SAM_GOV_API_KEY, so a malformed or hijacked description URL can't
  // exfiltrate the key to another host. Not a fetch failure — same "proceed
  // without it" contract as a 404 below.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: true, text: null };
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.sam.gov") {
    logEvent(
      "error.swallowed",
      { kind: "gov-solicitation.description_url_rejected", host: parsed.hostname },
      "warn",
    );
    return { ok: true, text: null };
  }
  const withKey = url.includes("?")
    ? `${url}&api_key=${encodeURIComponent(apiKey)}`
    : `${url}?api_key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(withKey, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS),
      // The credentialed request must not be replayed against a redirect
      // target — same host-pinning intent as the check above.
      redirect: "error",
    });
    if (res.status === 404) return { ok: true, text: null };
    if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 429 };
    // A 200 whose body isn't valid JSON is a platform anomaly, not "no
    // description" — let it reach the outer catch so it's classified
    // transient (retryable) rather than silently swallowed as ok/null.
    const json = (await res.json()) as { description?: string };
    const text = typeof json.description === "string" ? json.description : null;
    return { ok: true, text };
  } catch {
    // Network error / timeout — always transient.
    return { ok: false, transient: true };
  }
}

/**
 * Strip the HTML SAM.gov description bodies are often wrapped in, cheaply.
 * Deliberately a single linear pass (not a `<[^>]+>` regex replace) — that
 * regex backtracks quadratically on a string of unclosed `<` characters with
 * no `>` (each failed match retries one char shorter at every position, an
 * O(n²) blowup CodeQL flags as "Polynomial regular expression used on
 * uncontrolled data": SAM.gov's own description bodies are exactly the
 * uncontrolled string this walks). This scan is O(n) regardless of input.
 */
export function stripHtml(html: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") {
      inTag = true;
    } else if (ch === ">") {
      inTag = false;
      out += " ";
    } else if (!inTag) {
      out += ch;
    }
  }
  return out
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface GovSolicitationCandidate {
  noticeId: string;
  title: string;
  noticeNumber: string;
  noticeType: string;
  agency: string;
  naicsCode: string;
  postedDate: string;
  responseDeadline: string | null;
  noticeUrl: string;
  descriptionUrl: string | null;
  poc: SamPointOfContact;
}

/** First POC entry carrying BOTH a name and an email — the only usable kind. */
function pickPoc(pocs: SamPointOfContact[] | null | undefined): SamPointOfContact | null {
  for (const p of pocs ?? []) {
    if (p.email && p.email.trim().length > 0 && p.fullName && p.fullName.trim().length > 0) {
      return p;
    }
  }
  return null;
}

function toCandidate(o: SamOpportunity): GovSolicitationCandidate | null {
  const poc = pickPoc(o.pointOfContact);
  if (!poc) return null;
  // SAM.gov documents `uiLink`/`description` as literal the STRING "null"
  // (not JSON null) when the field has no real value — see
  // open.gsa.gov/api/get-opportunities-public-api. Trim + compare against
  // that sentinel before using either field, or a "null" uiLink becomes an
  // unusable notice link and a "null" description becomes an unfetchable
  // `null?api_key=...` request.
  const trimmedUiLink = o.uiLink?.trim();
  const usableUiLink = trimmedUiLink && trimmedUiLink !== "null" ? trimmedUiLink : null;
  const trimmedDescription = o.description?.trim();
  const usableDescriptionUrl =
    trimmedDescription && trimmedDescription !== "null" ? trimmedDescription : null;
  return {
    noticeId: o.noticeId,
    title: o.title,
    noticeNumber: o.solicitationNumber?.trim() || o.noticeId,
    noticeType: o.baseType?.trim() || o.type?.trim() || "Solicitation",
    agency: o.fullParentPathName?.trim() || "Unknown agency",
    naicsCode: o.naicsCode?.trim() || "",
    postedDate: o.postedDate?.trim() || "",
    responseDeadline: o.responseDeadLine?.trim() || null,
    noticeUrl: usableUiLink ?? `https://sam.gov/opp/${o.noticeId}/view`,
    descriptionUrl: usableDescriptionUrl,
    poc,
  };
}

interface GovSolicitationTarget {
  agency: string;
  noticeNumber: string;
  noticeType: string;
  title: string;
  naicsCode: string;
  name: string;
  email: string;
  role?: string;
  phone?: string;
  noticeUrl: string;
  postedDate: string;
  responseDeadline?: string;
  descriptionSnippet?: string;
  yourEdge: string;
}

function buildTarget(
  c: GovSolicitationCandidate,
  description: string | null,
  yourEdge: string,
): GovSolicitationTarget {
  return {
    agency: c.agency,
    noticeNumber: c.noticeNumber,
    noticeType: c.noticeType,
    title: c.title,
    naicsCode: c.naicsCode,
    name: c.poc.fullName!.trim(),
    email: c.poc.email!.trim(),
    ...(c.poc.title?.trim() ? { role: c.poc.title.trim() } : {}),
    ...(c.poc.phone?.trim() ? { phone: c.poc.phone.trim() } : {}),
    noticeUrl: c.noticeUrl,
    postedDate: c.postedDate,
    ...(c.responseDeadline ? { responseDeadline: c.responseDeadline } : {}),
    ...(description ? { descriptionSnippet: stripHtml(description).slice(0, 800) } : {}),
    yourEdge,
  };
}

function playForNoticeType(noticeType: string): "sources-sought" | "design-partner-loi" {
  return isPreSolicitationType(noticeType) ? "sources-sought" : "design-partner-loi";
}

/**
 * True when `deadline` parses to an instant strictly before `now`. An
 * unparseable/missing deadline is NOT treated as expired — SAM.gov's
 * `responseDeadLine` is optional and its format isn't guaranteed, so failing
 * open (keep the candidate) beats silently dropping a real notice on a date
 * this can't read.
 */
function isExpiredDeadline(deadline: string | null, now: Date = new Date()): boolean {
  if (!deadline) return false;
  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < now.getTime();
}

/**
 * Resolve + enqueue one already-discovered SAM.gov notice. Shared by the live
 * run loop and the outage retry handler. The only network call here is the
 * plain (non-SDK) description fetch — findEmail/verifyEmail are never called,
 * since the notice already publishes a verified POC.
 */
async function resolveAndEnqueueNotice(
  candidate: GovSolicitationCandidate,
  yourEdge: string,
  apiKey: string,
): Promise<"enqueued" | "duplicate" | "expired" | "platform-error"> {
  const ledger = getLedger();
  const dedupeKey = candidate.noticeId;
  // A closed response window is never worth enqueueing, and a deadline only
  // moves further into the past, so it's never worth a retry either.
  if (isExpiredDeadline(candidate.responseDeadline)) return "expired";
  const playName = playForNoticeType(candidate.noticeType);
  // Cross-play email dedupe BEFORE the description fetch: two distinct SAM
  // notices can share the same POC email (an office admin listed on
  // multiple solicitations), and enqueueTarget's own (playName, dedupeKey)
  // check can't see that — it only catches the exact same noticeId twice.
  if (isDuplicate({ playName, dedupeKey, prospectEmail: candidate.poc.email })) {
    return "duplicate";
  }
  let description: string | null = null;
  if (candidate.descriptionUrl) {
    const outcome = await fetchDescription(candidate.descriptionUrl, apiKey);
    if (!outcome.ok) {
      if (outcome.transient) return "platform-error";
      // Non-transient failure (unexpected non-404 error) — proceed without it.
    } else {
      description = outcome.text;
    }
  }
  const target = buildTarget(candidate, description, yourEdge);
  const id = enqueueScoredTarget(ledger, {
    playName,
    payload: target,
    dedupeKey,
    source: SOURCE,
    notes: `${candidate.noticeType} — ${candidate.agency} — ${candidate.title}`.slice(0, 300),
  });
  return id != null ? "enqueued" : "duplicate";
}

export async function runGovSolicitationFinder(
  opts: GovSolicitationFinderOpts,
): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const naics = (opts.naics ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
  const noticeTypes = (opts.noticeTypes ?? ["r", "p"])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const agencies = (opts.agencies ?? [])
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  const sinceDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, opts.sinceDays ?? 30));
  const yourEdge = (opts.yourEdge ?? "").trim();
  const ledger = getLedger();
  const apiKey = (process.env["SAM_GOV_API_KEY"] ?? "").trim();

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  if (!apiKey) {
    result.halted = "set SAM_GOV_API_KEY in .env";
    return result;
  }
  if (naics.length === 0) {
    result.halted = "set `naics` (one or more 6-digit NAICS codes)";
    return result;
  }
  if (noticeTypes.length === 0) {
    result.halted = "set `noticeTypes` (e.g. ['r','p'])";
    return result;
  }

  const now = new Date();
  const postedFrom = formatSamDate(new Date(now.getTime() - sinceDays * 24 * 3600 * 1000));
  const postedTo = formatSamDate(now);
  const ptype = noticeTypes.join(",");

  const seenNoticeIds = new Set<string>();
  const rawOpportunities: SamOpportunity[] = [];
  let anyFetchSucceeded = false;
  for (const code of naics) {
    const opportunities = await fetchOpportunitiesForNaics({
      apiKey,
      naics: code,
      ptype,
      postedFrom,
      postedTo,
    });
    if (opportunities == null) continue;
    anyFetchSucceeded = true;
    for (const o of opportunities) {
      // A search response can carry a null/malformed element, or one with no
      // noticeId, alongside good ones. Drop only that element — dereferencing
      // it here throws outside any catch and fails the whole run; an element
      // with a missing noticeId would otherwise pass through as an
      // `undefined` dedupe key and a "https://sam.gov/opp/undefined/view"
      // notice URL.
      if (!o || typeof o !== "object") continue;
      if (typeof o.noticeId !== "string" || o.noticeId.trim().length === 0) continue;
      if (seenNoticeIds.has(o.noticeId)) continue;
      seenNoticeIds.add(o.noticeId);
      rawOpportunities.push(o);
    }
  }

  if (!anyFetchSucceeded) {
    result.halted = `SAM.gov search failed for every configured NAICS code (${naics.join(", ")})`;
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }

  result.candidates = rawOpportunities.length;
  logEvent("finder.start", { name: PLAY_NAME, naics: naics.length, since_days: sinceDays, limit });

  for (const raw of rawOpportunities.slice(0, limit)) {
    if (result.enqueued >= limit) break;

    if (agencies.length > 0) {
      const agencyName = (raw.fullParentPathName ?? "").toLowerCase();
      if (!agencies.some((a) => agencyName.includes(a))) {
        result.droppedIcp++;
        continue;
      }
    }

    if (
      ledger.isQueueDuplicate("sources-sought", raw.noticeId) ||
      ledger.isQueueDuplicate("design-partner-loi", raw.noticeId) ||
      ledger.isPendingResolution(PLAY_NAME, raw.noticeId)
    ) {
      result.droppedDuplicate++;
      continue;
    }

    const candidate = toCandidate(raw);
    if (!candidate) {
      // No POC with both a name and an email — this is the one thing SAM.gov
      // must publish for this finder to be worth anything; nothing to enrich.
      result.droppedEnrichment++;
      continue;
    }

    if (isExpiredDeadline(candidate.responseDeadline)) {
      // A closed response window is never a real candidate — keep the
      // dry-run preview honest with what a live run would actually enqueue.
      result.droppedEnrichment++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    const outcome = await resolveAndEnqueueNotice(candidate, yourEdge, apiKey);
    if (outcome === "enqueued") result.enqueued++;
    else if (outcome === "duplicate") result.droppedDuplicate++;
    else if (outcome === "expired") result.droppedEnrichment++;
    else {
      // Transient platform error fetching the description — the notice's
      // response window is time-boxed, so persist rather than lose it.
      persistPending({
        playName: PLAY_NAME,
        dedupeKey: raw.noticeId,
        source: SOURCE,
        raw: { candidate, yourEdge },
      });
      result.droppedEnrichment++;
    }
  }

  logEvent("finder.done", {
    name: PLAY_NAME,
    candidates: result.candidates,
    enqueued: result.enqueued,
    dropped_icp: result.droppedIcp,
    dropped_dup: result.droppedDuplicate,
    dropped_enrich: result.droppedEnrichment,
    halted: result.halted ?? null,
  });
  return result;
}

// Outage retry: re-run the description fetch + enqueue for a persisted
// notice. The description link doesn't age out (unlike a live search
// window), so a retry days later is still meaningful.
registerPendingRetry(PLAY_NAME, async (raw) => {
  const { candidate, yourEdge } = raw as { candidate: GovSolicitationCandidate; yourEdge: string };
  const apiKey = (process.env["SAM_GOV_API_KEY"] ?? "").trim();
  if (!apiKey) return "platform-error";
  const outcome = await resolveAndEnqueueNotice(candidate, yourEdge, apiKey);
  return outcome === "enqueued"
    ? "enqueued"
    : outcome === "duplicate" || outcome === "expired"
      ? "dropped"
      : "platform-error";
});
