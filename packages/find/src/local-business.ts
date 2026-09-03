import { getLedger, logEvent, type CompanyResult, type PersonResult } from "@oneshot-gtm/core";
import { resolveVerifyEnrichQualify } from "./_contact.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection, qualifyPostEnrich } from "./_qualify.ts";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { safeCompanySearch, safePeopleSearch } from "./_sdk-safe.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "free-pilot";
const SOURCE = "find:local-business";

/**
 * Server cap on `research/people` — flat $0.01 regardless of how many of the
 * up-to-500 rows come back, so always ask for the max.
 */
const PEOPLE_SEARCH_LIMIT = 500;
/** Server cap on `research/company`. */
const COMPANY_SEARCH_LIMIT = 100;

export interface LocalBusinessFinderOpts extends RunOpts {
  /** Roles to search for (e.g. "Owner", "Office Manager"). */
  jobTitles?: string[];
  /** Industries to search for (e.g. "Dental Practices", "HVAC Contractors"). */
  industries?: string[];
  /** Metro/city/state filters, fed to both peopleSearch and companySearch. */
  locations?: string[];
  /** Company-size band, e.g. "1-10", "11-50" — fed to both search calls. */
  employeeRange?: string;
  /** Free-text keywords, fed to peopleSearch only. */
  keywords?: string[];
  /** The free-pilot pitch: what you set up for them free. REQUIRED via readiness. */
  yourEdge: string;
}

function nonEmptyStrings(vals: string[] | undefined): string[] {
  return (vals ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Stable dedupe key for a `PersonResult`. LinkedIn URL is the strongest
 * disambiguator (present on most rows); email next; a name+domain composite
 * is the last resort so a row with neither still gets a workable key instead
 * of colliding with every other nameless/domainless candidate.
 */
function candidateDedupeKey(person: PersonResult): string {
  const linkedin = person.linkedin_url?.trim().toLowerCase();
  if (linkedin) return `${PLAY_NAME}:li:${linkedin}`;
  const email = (person.best_work_email ?? person.email ?? person.best_personal_email)
    ?.trim()
    .toLowerCase();
  if (email) return `${PLAY_NAME}:em:${email}`;
  const domain = person.company_domain?.trim().toLowerCase() ?? "";
  const name = (person.full_name ?? `${person.first_name ?? ""} ${person.last_name ?? ""}`)
    .trim()
    .toLowerCase();
  return `${PLAY_NAME}:nd:${name}@${domain}`;
}

/** `phone` first, else the first `fullphone` entry. Both are optional on `PersonResult`. */
function readPhone(person: PersonResult): string | null {
  const direct = person.phone?.trim();
  if (direct) return direct;
  const first = person.fullphone?.[0]?.fullphone?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * local-business finder: `peopleSearch` (and, for business-shaped targeting,
 * a `companySearch` pass first) against the OneShot B2B database, routed to
 * the `free-pilot` play. This is the only finder that reaches a business with
 * no GitHub repo, no Show HN post, no funding round and no accelerator batch —
 * see issue #457.
 *
 * Two lanes off one search, because the cost profile differs sharply:
 * a `PersonResult` carrying `best_work_email` skips `findEmail`/`verifyEmail`
 * entirely and goes straight to the person-level ICP gate; one without it
 * runs the normal `resolveVerifyEnrichQualify` spine. `FinderResult` doesn't
 * distinguish the lanes in its shape — both funnel into the same enqueue —
 * but the cost each accrues is very different, which is the whole point of
 * this finder over the per-candidate spine every other finder uses.
 */
export async function runLocalBusinessFinder(opts: LocalBusinessFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();

  const jobTitles = nonEmptyStrings(opts.jobTitles);
  const industries = nonEmptyStrings(opts.industries);
  const locations = nonEmptyStrings(opts.locations);
  const keywords = nonEmptyStrings(opts.keywords);
  const employeeRange = opts.employeeRange?.trim() || undefined;
  const yourEdge = (opts.yourEdge ?? "").trim();

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    droppedRole: 0,
    enqueued: 0,
    costUsd: 0,
  };

  // Business-shaped targeting (industries set, no job titles): resolve the
  // company slate first via companySearch, then feed its domains into
  // peopleSearch instead of searching on industry directly. Title-shaped
  // targeting (jobTitles set) skips straight to peopleSearch.
  const businessShaped = jobTitles.length === 0 && industries.length > 0;

  logEvent("finder.start", {
    name: PLAY_NAME,
    business_shaped: businessShaped,
    job_titles: jobTitles.length,
    industries: industries.length,
    limit,
  });

  let companyDomains: string[] = [];
  const domainIndustry = new Map<string, string>();
  if (businessShaped) {
    const companyRes = await safeCompanySearch(
      {
        industry: industries,
        ...(locations.length > 0 ? { location: locations } : {}),
        ...(employeeRange ? { size: employeeRange } : {}),
        limit: COMPANY_SEARCH_LIMIT,
      },
      { playName: PLAY_NAME },
    );
    result.costUsd += companyRes.result.cost ?? 0;
    const seenDomains = new Set<string>();
    for (const c of companyRes.result.results as CompanyResult[]) {
      const domain = c.domain?.trim().toLowerCase();
      if (!domain || seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      companyDomains.push(domain);
      if (c.industry) domainIndustry.set(domain, c.industry);
    }

    if (companyDomains.length === 0) {
      result.halted =
        "companySearch returned no companies for the given industries — widen locations/employeeRange or set jobTitles";
      logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
      return result;
    }
  }

  const peopleRes = await safePeopleSearch(
    {
      ...(businessShaped
        ? { companyDomains }
        : {
            ...(jobTitles.length > 0 ? { jobTitles } : {}),
            ...(industries.length > 0 ? { industry: industries } : {}),
          }),
      ...(locations.length > 0 ? { location: locations } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(employeeRange ? { companySize: employeeRange } : {}),
      limit: PEOPLE_SEARCH_LIMIT,
    },
    { playName: PLAY_NAME },
  );
  result.costUsd += peopleRes.result.cost ?? 0;
  const candidates = peopleRes.result.results as PersonResult[];
  result.candidates = candidates.length;

  if (candidates.length === 0) {
    result.halted = businessShaped
      ? "peopleSearch returned no matches for the resolved company domains"
      : "peopleSearch returned no matches — widen jobTitles/industries/locations";
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }

  const fallbackBusinessType = industries.length > 0 ? industries.join(" / ") : "local business";

  for (const person of candidates) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }

    const fullName = (
      person.full_name ?? `${person.first_name ?? ""} ${person.last_name ?? ""}`
    ).trim();
    if (!fullName) {
      result.droppedEnrichment++;
      continue;
    }
    const company = person.company?.trim() || "(unknown)";
    const title = person.title?.trim() || null;
    const dedupeKey = candidateDedupeKey(person);
    const businessType =
      (person.company_domain && domainIndustry.get(person.company_domain.trim().toLowerCase())) ||
      fallbackBusinessType;

    if (ledger.isQueueDuplicate(PLAY_NAME, dedupeKey)) {
      result.droppedDuplicate++;
      continue;
    }

    // ICP gate BEFORE any per-candidate paid call — the spend discipline every
    // sibling finder follows (peopleSearch/companySearch above is a single
    // flat-rate call per RUN, not per candidate, so it isn't gated here).
    const filter = await icpFilter({
      icp,
      candidate: {
        title: title || businessType,
        url: person.linkedin_url ?? undefined,
        summary: [company, title, businessType].filter(Boolean).join(" · "),
      },
    });
    if (filter.match === null) {
      // Transient classifier failure — drop without persisting (same
      // rationale as every other finder: a persisted rejection would burn
      // the dedupeKey for every future watch tick).
      result.droppedEnrichment++;
      continue;
    }
    if (!filter.match) {
      result.droppedIcp++;
      if (!opts.dryRun) {
        ledger.enqueueTarget({
          playName: PLAY_NAME,
          payload: { name: fullName, company, title, businessType },
          dedupeKey,
          source: SOURCE,
          initialStatus: "rejected",
          notes: `auto: ICP — ${filter.reason}`,
        });
      }
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    const bestWorkEmail = person.best_work_email?.trim() || null;

    let email: string;
    let phone: string | null;
    let linkedinUrl: string | null;
    let finalTitle: string | null;

    if (bestWorkEmail) {
      // Lane 1 — the search already carries a usable email: skip
      // findEmail/verifyEmail entirely and go straight to the person gate.
      const gate = await qualifyPostEnrich({
        icp,
        person: { name: fullName, company, roleText: title, evidence: "peopleSearch match" },
        enrichedTitle: title,
        enrichedSummary: person.summary ?? null,
        linkedinUrl: person.linkedin_url ?? null,
        fillGaps: opts.qualifyFillGaps ?? true,
        playName: PLAY_NAME,
        errKindPrefix: PLAY_NAME,
      });
      result.costUsd += gate.costUsd;
      if (gate.action === "reject") {
        result.droppedRole = (result.droppedRole ?? 0) + 1;
        persistRoleRejection({
          playName: PLAY_NAME,
          dedupeKey,
          payload: { name: fullName, company, title, businessType },
          source: SOURCE,
          reason: gate.reason,
          dryRun: opts.dryRun,
        });
        continue;
      }
      if (gate.action === "defer") {
        result.droppedEnrichment++;
        continue;
      }
      if (isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: bestWorkEmail })) {
        result.droppedDuplicate++;
        continue;
      }
      email = bestWorkEmail;
      phone = readPhone(person);
      linkedinUrl = person.linkedin_url ?? null;
      finalTitle = gate.roleText ?? title;
    } else {
      // Lane 2 — no email on the search result: the normal
      // resolve → verify → enrich → qualify spine every other finder uses.
      const contact = await resolveVerifyEnrichQualify({
        playName: PLAY_NAME,
        fullName,
        companyDomain: person.company_domain ?? null,
        isDuplicate: (candEmail) =>
          isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: candEmail }),
        icp,
        person: { name: fullName, company, roleText: title, evidence: "peopleSearch match" },
        linkedinUrlHint: person.linkedin_url ?? null,
        fillGaps: opts.qualifyFillGaps ?? true,
        errKindPrefix: PLAY_NAME,
      });
      result.costUsd += contact.costUsd;
      if (!contact.ok) {
        if (contact.reason === "duplicate") result.droppedDuplicate++;
        else if (contact.reason === "role") {
          result.droppedRole = (result.droppedRole ?? 0) + 1;
          persistRoleRejection({
            playName: PLAY_NAME,
            dedupeKey,
            payload: { name: fullName, company, title, businessType },
            source: SOURCE,
            reason: contact.detail ?? "off-ICP role",
            dryRun: opts.dryRun,
          });
        } else result.droppedEnrichment++;
        continue;
      }
      email = contact.email;
      phone = contact.phone;
      linkedinUrl = contact.linkedinUrl;
      finalTitle = contact.title ?? title;
    }

    // Payload mirrors the (issue #462) free-pilot play's `FreePilotTarget`
    // shape structurally — `enqueueTarget`'s payload is untyped `unknown`, so
    // this finder doesn't need to import that type to stay in sync with it.
    const target = {
      name: fullName,
      email,
      company,
      businessType,
      yourEdge,
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(linkedinUrl ? { sourceProfileUrl: linkedinUrl } : {}),
      ...(finalTitle ? { title: finalTitle } : {}),
    };

    const id = enqueueScoredTarget(ledger, {
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source: SOURCE,
      notes: filter.reason,
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
    dropped_role: result.droppedRole,
    cost_usd: result.costUsd,
    halted: result.halted ?? null,
  });
  return result;
}
