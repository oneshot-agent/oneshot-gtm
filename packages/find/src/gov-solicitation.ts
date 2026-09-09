import { getLedger, logEvent, type GovContact, type Solicitation } from "@oneshot-gtm/core";
import { isDuplicate } from "./_dedupe.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { resolveIcp } from "./_filter.ts";
import { FIT_REASON_COST_ESTIMATE_USD, generateFitReason } from "./_fit-reason.ts";
import { safeGovSolicitations } from "./_sdk-safe.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "gov-solicitation";
const SOURCE = "find:gov-solicitation";
/** SAM.gov's own ceiling: the posted-date window may span at most one year. */
const MAX_WINDOW_DAYS = 365;
/** Rows asked of the one flat-priced search per run — the SDK caps at 500. */
const RESULTS_PER_RUN = 200;

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
  /** Look-back window in days on the posted date. Default 30; clamped to 365 (SAM.gov's own cap). */
  sinceDays?: number;
  /** Founder's one-line angle, threaded to the play. REQUIRED via readiness gate. */
  yourEdge?: string;
}

const NOTICE_TYPE_CODES = new Set(["r", "p", "o", "k", "s", "a", "u", "i", "g"]);

/** True for a notice type name naming a sources-sought or presolicitation window. */
export function isPreSolicitationType(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  return /sources[\s_]*sought|presolicitation|pre-solicitation/i.test(typeName);
}

/**
 * Strip the HTML SAM.gov description bodies are often wrapped in, cheaply.
 * The SDK says its `description` is already stripped; nothing guarantees it,
 * and this pass is O(n). Deliberately a single linear scan (not a `<[^>]+>`
 * regex replace) — that regex backtracks quadratically on a string of
 * unclosed `<` characters with no `>` (CodeQL "Polynomial regular expression
 * used on uncontrolled data": a notice body is exactly the uncontrolled string
 * this walks).
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
  /** Human notice-type name, e.g. "Sources Sought" — what the play shows. */
  noticeType: string;
  /** SAM.gov code when the SDK carries one; drives routing ahead of the name. */
  noticeTypeCode: string | null;
  agency: string;
  naicsCode: string;
  postedDate: string;
  responseDeadline: string | null;
  noticeUrl: string;
  description: string | null;
  poc: { fullName: string; email: string; title: string | null; phone: string | null };
}

const NOTICE_TYPE_NAMES: Record<string, string> = {
  sources_sought: "Sources Sought",
  presolicitation: "Presolicitation",
  solicitation: "Solicitation",
  combined_synopsis: "Combined Synopsis/Solicitation",
  special_notice: "Special Notice",
  award: "Award Notice",
  justification: "Justification",
  other: "Solicitation",
};

/**
 * First contact carrying BOTH a name and an email — the only usable kind.
 * The SDK's `has_contact: true` asks the server for exactly this, but the
 * declared field types aren't contractually guaranteed at runtime (a
 * malformed row can carry a non-string email or a non-array `contacts`), and
 * `.trim()` on a non-string throws outside any try/catch here — which would
 * abort the whole enqueue loop and drop every later notice in the batch.
 */
function pickPoc(
  primary: GovContact | null | undefined,
  all: GovContact[] | null | undefined,
): GovSolicitationCandidate["poc"] | null {
  const pool: unknown[] = [];
  if (primary) pool.push(primary);
  if (Array.isArray(all)) pool.push(...all);
  for (const p of pool) {
    if (!p || typeof p !== "object") continue;
    const c = p as Record<string, unknown>;
    if (
      typeof c["email"] === "string" &&
      c["email"].trim().length > 0 &&
      typeof c["name"] === "string" &&
      c["name"].trim().length > 0
    ) {
      return {
        fullName: c["name"].trim(),
        email: c["email"].trim(),
        title: typeof c["title"] === "string" && c["title"].trim() ? c["title"].trim() : null,
        phone: typeof c["phone"] === "string" && c["phone"].trim() ? c["phone"].trim() : null,
      };
    }
  }
  return null;
}

function toCandidate(o: Solicitation): GovSolicitationCandidate | null {
  const poc = pickPoc(o.contact, o.contacts);
  if (!poc) return null;
  const code =
    typeof o.notice_type_code === "string" && NOTICE_TYPE_CODES.has(o.notice_type_code)
      ? o.notice_type_code
      : null;
  const typeName =
    (typeof o.notice_type === "string" && NOTICE_TYPE_NAMES[o.notice_type]) ||
    (typeof o.notice_type === "string" && o.notice_type.trim()) ||
    "Solicitation";
  const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : null;
  return {
    noticeId: o.notice_id,
    title: typeof o.title === "string" ? o.title : "",
    noticeNumber:
      (typeof o.solicitation_number === "string" && o.solicitation_number.trim()) || o.notice_id,
    noticeType: typeName,
    noticeTypeCode: code,
    agency: (typeof o.agency === "string" && o.agency.trim()) || "Unknown agency",
    naicsCode: (typeof o.naics_code === "string" && o.naics_code.trim()) || "",
    postedDate: (typeof o.posted_date === "string" && o.posted_date.trim()) || "",
    responseDeadline:
      (typeof o.response_deadline === "string" && o.response_deadline.trim()) || null,
    noticeUrl: url ?? `https://sam.gov/opp/${o.notice_id}/view`,
    description: typeof o.description === "string" && o.description.trim() ? o.description : null,
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

function buildTarget(c: GovSolicitationCandidate, yourEdge: string): GovSolicitationTarget {
  return {
    agency: c.agency,
    noticeNumber: c.noticeNumber,
    noticeType: c.noticeType,
    title: c.title,
    naicsCode: c.naicsCode,
    name: c.poc.fullName,
    email: c.poc.email,
    ...(c.poc.title ? { role: c.poc.title } : {}),
    ...(c.poc.phone ? { phone: c.poc.phone } : {}),
    noticeUrl: c.noticeUrl,
    postedDate: c.postedDate,
    ...(c.responseDeadline ? { responseDeadline: c.responseDeadline } : {}),
    ...(c.description ? { descriptionSnippet: stripHtml(c.description).slice(0, 800) } : {}),
    yourEdge,
  };
}

/**
 * `r`/`p` (the requirement is still being written) → sources-sought; every
 * other type → design-partner-loi. The code is authoritative when the SDK
 * carries one; the type name is the fallback.
 */
function playForNotice(c: GovSolicitationCandidate): "sources-sought" | "design-partner-loi" {
  if (c.noticeTypeCode) {
    return c.noticeTypeCode === "r" || c.noticeTypeCode === "p"
      ? "sources-sought"
      : "design-partner-loi";
  }
  return isPreSolicitationType(c.noticeType) ? "sources-sought" : "design-partner-loi";
}

/**
 * True when `deadline` parses to an instant strictly before `now`. An
 * unparseable/missing deadline is NOT treated as expired — the field is
 * optional and its format isn't guaranteed, so failing open (keep the
 * candidate) beats silently dropping a real notice on a date this can't read.
 * Belt-and-braces over the SDK's `active_only`, which is asked for too.
 */
function isExpiredDeadline(deadline: string | null, now: Date = new Date()): boolean {
  if (!deadline) return false;
  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < now.getTime();
}

export async function runGovSolicitationFinder(
  opts: GovSolicitationFinderOpts,
): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const naics = (opts.naics ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
  const noticeTypes = (opts.noticeTypes ?? ["r", "p"])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => NOTICE_TYPE_CODES.has(t));
  const agencies = (opts.agencies ?? [])
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  const sinceDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, opts.sinceDays ?? 30));
  const yourEdge = (opts.yourEdge ?? "").trim();
  const ledger = getLedger();
  // No ICP gate runs here (the notice publishes its own contact), so the fit
  // line is generated per row (#592) — one small call, or none without an ICP.
  const icp = resolveIcp(opts.icpOverride);

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  if (naics.length === 0) {
    result.halted = "set `naics` (one or more 6-digit NAICS codes)";
    return result;
  }
  if (noticeTypes.length === 0) {
    result.halted = "set `noticeTypes` (e.g. ['r','p'])";
    return result;
  }
  // The one paid call this finder makes is the search itself, so the cap has
  // to be checked BEFORE it, not only per candidate.
  if (opts.maxCostUsd != null && opts.maxCostUsd <= 0) {
    result.halted = `max-cost cap (${opts.maxCostUsd})`;
    return result;
  }

  logEvent("finder.start", { name: PLAY_NAME, naics: naics.length, since_days: sinceDays, limit });

  // One flat-priced search for every NAICS code at once (the SDK takes up to
  // 20 per call); the contact and description come back inline, so there is
  // no per-notice fetch left — and no SAM.gov key.
  const search = await safeGovSolicitations(
    {
      naics: naics.slice(0, 20),
      noticeTypes: noticeTypes as GovSolicitationsInputNoticeTypes,
      sinceDays,
      ...(agencies.length > 0 ? { agencies } : {}),
      hasContact: true,
      activeOnly: true,
      includeDescription: true,
      limit: RESULTS_PER_RUN,
    },
    { playName: PLAY_NAME },
  );
  result.costUsd += search.result.cost ?? 0;
  if (search.result.status === "error") {
    // A caught throw, not a genuine "no notices" — say so, or an outage reads
    // as bad NAICS targeting (the same distinction local-business draws).
    result.halted = "govSolicitations failed (platform error) — see logs";
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }

  const seenNoticeIds = new Set<string>();
  const notices: Solicitation[] = [];
  for (const o of search.result.results as unknown[]) {
    // A result can carry a null/malformed element, or one with no notice_id,
    // alongside good ones. Drop only that element — dereferencing it here
    // throws outside any catch and fails the whole run; a missing notice_id
    // would otherwise become an `undefined` dedupe key and an
    // "https://sam.gov/opp/undefined/view" notice URL.
    if (!o || typeof o !== "object") continue;
    const id = (o as { notice_id?: unknown }).notice_id;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    if (seenNoticeIds.has(id)) continue;
    seenNoticeIds.add(id);
    notices.push(o as Solicitation);
  }
  result.candidates = notices.length;

  for (const raw of notices) {
    if (result.enqueued >= limit) break;

    if (agencies.length > 0) {
      // The SDK filters server-side too; re-checking here is free and keeps
      // the finder honest if that filter ever loosens.
      const agencyName = (typeof raw.agency === "string" ? raw.agency : "").toLowerCase();
      if (!agencies.some((a) => agencyName.includes(a))) {
        result.droppedIcp++;
        continue;
      }
    }

    if (
      ledger.isQueueDuplicate("sources-sought", raw.notice_id) ||
      ledger.isQueueDuplicate("design-partner-loi", raw.notice_id)
    ) {
      result.droppedDuplicate++;
      continue;
    }

    const candidate = toCandidate(raw);
    if (!candidate) {
      // No contact with both a name and an email — the one thing a notice must
      // publish for this finder to be worth anything; nothing to enrich.
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

    const playName = playForNotice(candidate);
    // Cross-play email dedupe: two distinct notices can share the same POC
    // email (an office admin listed on multiple solicitations), and the
    // (playName, dedupeKey) check above can't see that.
    if (
      isDuplicate({ playName, dedupeKey: candidate.noticeId, prospectEmail: candidate.poc.email })
    ) {
      result.droppedDuplicate++;
      continue;
    }

    const target = buildTarget(candidate, yourEdge);
    const fitReason = await generateFitReason({ icp, playName, payload: target });
    if (icp && fitReason) result.costUsd += FIT_REASON_COST_ESTIMATE_USD;
    const id = enqueueScoredTarget(ledger, {
      playName,
      payload: target,
      dedupeKey: candidate.noticeId,
      source: SOURCE,
      fitReason,
      fitReasonSource: "generated",
      notes: `${candidate.noticeType} — ${candidate.agency} — ${candidate.title}`.slice(0, 300),
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  logEvent("finder.done", {
    name: PLAY_NAME,
    candidates: result.candidates,
    enqueued: result.enqueued,
    dropped_icp: result.droppedIcp,
    dropped_dup: result.droppedDuplicate,
    dropped_enrich: result.droppedEnrichment,
    cost_usd: result.costUsd,
    halted: result.halted ?? null,
  });
  return result;
}

type GovSolicitationsInputNoticeTypes = NonNullable<
  Parameters<typeof safeGovSolicitations>[0]["noticeTypes"]
>;
