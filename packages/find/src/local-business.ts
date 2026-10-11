import { createHash } from "node:crypto";
import {
  getLedger,
  logEvent,
  type CompanyResult,
  type LocalResult,
  type PeopleSearchInput,
  type PersonResult,
} from "@oneshot-gtm/core";
import { icpFields, resolveVerifyEnrichQualify } from "./_contact.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection, qualifyPostEnrich } from "./_qualify.ts";
import { isDuplicate } from "./_dedupe.ts";
import { finderChannels } from "./_channels-context.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { safeCompanySearch, safeLocalSearch, safePeopleSearch } from "./_sdk-safe.ts";
import { buildDesignPartnerLoiPayload, dedupePlayNames, resolvePlayRoute } from "./_play-route.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "free-pilot";
const SOURCE = "find:local-business";

/**
 * Rows asked of `research/people` per page. The price is flat ($0.01) but the
 * platform ends the job at 120s and its time per row swings: ~2.2s per row on
 * 2026-09-27 (50 → 107s, 100 and 500 → "timed out after 120s", an empty run),
 * 0.1 to 1s per row on 2026-10-11. A page of 40 finishes at the slow end too;
 * more people come from the next page (`offset`), not a bigger one.
 */
const PEOPLE_SEARCH_LIMIT = 40;
/** Pages read of one search before it is treated as walked. */
const MAX_PAGES_PER_QUERY = 6;
/** People searches one run may make, across every query and page. */
const MAX_SEARCHES_PER_RUN = 12;
/** How long a search that had no one new is left alone before it is read again. */
const FINISHED_QUERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Server cap on `research/company`. */
const COMPANY_SEARCH_LIMIT = 100;
/** Server cap on `local/search`: flat price per search, so always ask for the max. */
const LOCAL_SEARCH_LIMIT = 500;

/**
 * Which SDK tool discovers candidates. `b2b` (default, the original finder) is
 * `peopleSearch`/`companySearch` against the B2B people database; `local` is
 * the SDK's `localSearch`: category × location over the places index, which
 * is where a main-street business with no LinkedIn footprint actually lives.
 * Opt-in: no existing trigger or pack changes engine by itself.
 */
export type LocalBusinessEngine = "b2b" | "local";

export interface LocalBusinessFinderOpts extends RunOpts {
  /** Roles to search for (e.g. "Owner", "Office Manager"). */
  jobTitles?: string[];
  /** Industries to search for (e.g. "Dental Practices", "HVAC Contractors"). */
  industries?: string[];
  /** Metro/city/state filters, fed to both peopleSearch and companySearch. */
  locations?: string[];
  /** Company-size band, e.g. "1-10", "11-50": fed to both search calls. */
  employeeRange?: string;
  /** Free-text keywords, fed to peopleSearch only. */
  keywords?: string[];
  /** The free-pilot pitch: what you set up for them free. REQUIRED via readiness. */
  yourEdge: string;
  /** Discovery engine. Default `b2b`. See `LocalBusinessEngine`. */
  engine?: LocalBusinessEngine;
  /**
   * Route this finder's rows to `design-partner-loi` (the enterprise
   * register) instead of `free-pilot`. `"design-partner-loi"` opts in;
   * absent = today's behaviour, unchanged. Requires `buyerType`. See #705.
   */
  play?: string;
  /** Required when `play` is `"design-partner-loi"`. See `DesignPartnerLoiTarget.buyerType`. */
  buyerType?: string;
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

function personFullName(person: PersonResult): string {
  return (person.full_name ?? `${person.first_name ?? ""} ${person.last_name ?? ""}`).trim();
}

/**
 * A search row the contact steps can use: a first and a last name, and
 * something that places the person (company domain, profile or email). The
 * people database also returns name-only rows (`full_name: "David"`, every
 * other field null: measured 2026-10-11, all 100 rows for one title), which
 * no later step can turn into a contact.
 */
export function isContactable(person: PersonResult): boolean {
  const hasLastName =
    Boolean(person.last_name?.trim()) || personFullName(person).split(/\s+/).length >= 2;
  if (!hasLastName) return false;
  return Boolean(
    person.company_domain?.trim() ||
    person.linkedin_url?.trim() ||
    person.best_work_email?.trim() ||
    person.email?.trim() ||
    person.best_personal_email?.trim(),
  );
}

/**
 * The searches one run walks, in order. Business-shaped targeting has one
 * (the resolved company domains). Title-shaped targeting has the combined
 * search, then one per title when there are several: each title alone
 * returns people the combined search's first pages never reach.
 */
export function peopleQueries(args: {
  businessShaped: boolean;
  companyDomains: string[];
  jobTitles: string[];
  industries: string[];
  shared: Pick<PeopleSearchInput, "location" | "keywords" | "companySize">;
}): PeopleSearchInput[] {
  if (args.businessShaped) return [{ companyDomains: args.companyDomains, ...args.shared }];
  const base: PeopleSearchInput = {
    ...(args.industries.length > 0 ? { industry: args.industries } : {}),
    ...args.shared,
  };
  const combined: PeopleSearchInput = {
    ...(args.jobTitles.length > 0 ? { jobTitles: args.jobTitles } : {}),
    ...base,
  };
  if (args.jobTitles.length < 2) return [combined];
  return [combined, ...args.jobTitles.map((title) => ({ jobTitles: [title], ...base }))];
}

function finishedQueryKey(query: PeopleSearchInput): string {
  const hash = createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 16);
  return `people-search-finished:${hash}`;
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
 * no GitHub repo, no Show HN post, no funding round and no accelerator batch:
 * see issue #457.
 *
 * Two lanes off one search, because the cost profile differs sharply:
 * a `PersonResult` carrying `best_work_email` skips `findEmail`/`verifyEmail`
 * entirely and goes straight to the person-level ICP gate; one without it
 * runs the normal `resolveVerifyEnrichQualify` spine. `FinderResult` doesn't
 * distinguish the lanes in its shape. Both funnel into the same enqueue:
 * but the cost each accrues is very different, which is the whole point of
 * this finder over the per-candidate spine every other finder uses.
 *
 * The search is read a page at a time (`peopleQueries` lists the searches,
 * `offset` pages each) until `limit` people the queue has not seen are
 * worked. People already there are skipped free and do not count: the
 * database returns the same people in the same order every day, so counting
 * them stopped the finder on its first page.
 */
export async function runLocalBusinessFinder(opts: LocalBusinessFinderOpts): Promise<FinderResult> {
  if (opts.engine === "local") return runLocalEngine(opts);
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();

  const jobTitles = nonEmptyStrings(opts.jobTitles);
  const industries = nonEmptyStrings(opts.industries);
  const locations = nonEmptyStrings(opts.locations);
  const keywords = nonEmptyStrings(opts.keywords);
  const employeeRange = opts.employeeRange?.trim() || undefined;
  const yourEdge = (opts.yourEdge ?? "").trim();
  const route = resolvePlayRoute(opts);
  const dedupeScope = dedupePlayNames(PLAY_NAME);

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
    // `status === "error"` means safeCompanySearch caught a throw (backend
    // outage/transport failure). The sentinel's `results: []` is not a
    // genuine "no companies for this industry" answer. Treating it as one
    // reported misleading targeting guidance for what was really a platform
    // failure (finding PRRT_kwDOSKzrBs6fCBdS).
    if (companyRes.result.status === "error") {
      result.halted = "companySearch failed (platform error) — see logs";
      logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
      return result;
    }
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

  if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
    result.halted = `max-cost cap (${opts.maxCostUsd})`;
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }

  const fallbackBusinessType = industries.length > 0 ? industries.join(" / ") : "local business";

  /** One new person through the gates and into the queue. */
  const workCandidate = async (
    person: PersonResult,
    fullName: string,
    dedupeKey: string,
  ): Promise<void> => {
    const company = person.company?.trim() || "(unknown)";
    const title = person.title?.trim() || null;
    const businessType =
      (person.company_domain && domainIndustry.get(person.company_domain.trim().toLowerCase())) ||
      fallbackBusinessType;

    // ICP gate BEFORE any per-candidate paid call. The spend discipline every
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
      // Transient classifier failure: drop without persisting (same
      // rationale as every other finder: a persisted rejection would burn
      // the dedupeKey for every future watch tick).
      result.droppedEnrichment++;
      return;
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
      return;
    }

    if (opts.dryRun) {
      result.enqueued++;
      return;
    }

    const bestWorkEmail = person.best_work_email?.trim() || null;

    let email: string;
    let channel: "email" | "linkedin" | "x" = "email";
    let phone: string | null;
    let linkedinUrl: string | null;
    let finalTitle: string | null;
    // ICP verdict fields for the routed (design-partner-loi) payload only:
    // never spread onto `target` below, which must keep matching its
    // pre-#705 shape (finding PRRT_kwDOSKzrBs6mB74J, issue #705 round 1).
    let routedIcp: Record<string, unknown> = {};

    // Lane 1 only when email leads the run's channel order; otherwise the
    // shared spine walks the order, reusing the search's email if it gets there.
    if (bestWorkEmail && finderChannels()[0] === "email") {
      // Lane 1. The search already carries a usable email: skip
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
        return;
      }
      if (gate.action === "defer") {
        result.droppedEnrichment++;
        return;
      }
      if (isDuplicate({ playName: dedupeScope, dedupeKey, prospectEmail: bestWorkEmail })) {
        result.droppedDuplicate++;
        return;
      }
      email = bestWorkEmail;
      phone = readPhone(person);
      linkedinUrl = person.linkedin_url ?? null;
      finalTitle = gate.roleText ?? title;
      // `gate` is a `QualifyOutcome`, not a `QualifiedContact`: build the
      // same `icpVerdict`/`icpVerdictReason` shape `icpFields` produces for
      // the other lane, by hand.
      routedIcp = {
        icpVerdict: gate.verdict,
        ...(gate.reason ? { icpVerdictReason: gate.reason } : {}),
      };
    } else {
      // Lane 2: no email on the search result (or email isn't first): the normal
      // resolve → verify → enrich → qualify spine every other finder uses.
      const contact = await resolveVerifyEnrichQualify({
        playName: PLAY_NAME,
        fullName,
        companyDomain: person.company_domain ?? null,
        knownEmail: bestWorkEmail,
        isDuplicate: (candEmail) =>
          isDuplicate({ playName: dedupeScope, dedupeKey, prospectEmail: candEmail }),
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
        return;
      }
      // "" on a LinkedIn-channel contact: the row's channel decides how it is sent.
      email = contact.email ?? "";
      channel = contact.channel;
      phone = contact.phone;
      linkedinUrl = contact.linkedinUrl;
      finalTitle = contact.title ?? title;
      routedIcp = icpFields(contact);
    }

    // Payload mirrors the (issue #462) free-pilot play's `FreePilotTarget`
    // shape structurally: `enqueueTarget`'s payload is untyped `unknown`, so
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
      playName: route ? route.playName : PLAY_NAME,
      payload: route
        ? buildDesignPartnerLoiPayload({
            name: fullName,
            email,
            company,
            buyerType: route.buyerType,
            yourEdge,
            title: finalTitle,
            linkedinUrl,
            phone,
            icp: routedIcp,
          })
        : target,
      dedupeKey,
      source: SOURCE,
      fitReason: filter.reason,
      notes: filter.reason,
      channel,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  };

  const queries = peopleQueries({
    businessShaped,
    companyDomains,
    jobTitles,
    industries,
    shared: {
      ...(locations.length > 0 ? { location: locations } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(employeeRange ? { companySize: employeeRange } : {}),
    },
  });
  const seenThisRun = new Set<string>();
  let worked = 0;
  let searches = 0;
  let unusable = 0;
  let finishedQueries = 0;
  let stop = false;

  for (const query of queries) {
    if (stop) break;
    const finishedKey = finishedQueryKey(query);
    if (ledger.getProductResearchCache(finishedKey, FINISHED_QUERY_TTL_MS)) {
      finishedQueries++;
      continue;
    }
    let offset = 0;
    let fresh = 0;
    let known = 0;
    let ended = false;
    let previousFirstKey: string | null = null;
    for (let page = 0; !stop && !ended; page++) {
      if (page >= MAX_PAGES_PER_QUERY) {
        ended = true;
        break;
      }
      if (worked >= limit || searches >= MAX_SEARCHES_PER_RUN) {
        stop = true;
        break;
      }
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
        result.halted = `max-cost cap (${opts.maxCostUsd})`;
        stop = true;
        break;
      }
      const peopleRes = await safePeopleSearch(
        { ...query, limit: PEOPLE_SEARCH_LIMIT, ...(offset > 0 ? { offset } : {}) },
        { playName: PLAY_NAME },
      );
      searches++;
      result.costUsd += peopleRes.result.cost ?? 0;
      if (peopleRes.result.status === "error") {
        // Same distinction as companySearch above: an empty `results` from a
        // caught throw is a platform failure, not "no matches" (finding
        // PRRT_kwDOSKzrBs6fCBdS). Later searches would fail the same way.
        if (result.candidates === 0) {
          result.halted = "peopleSearch failed (platform error) — see logs";
        }
        stop = true;
        break;
      }
      const rows = peopleRes.result.results as PersonResult[];
      result.candidates += rows.length;
      const firstKey = rows[0] ? candidateDedupeKey(rows[0]) : null;
      // An empty page is the end. So is the same page twice: a server that
      // ignores `offset` would otherwise be walked to the page cap.
      if (rows.length === 0 || (offset > 0 && firstKey === previousFirstKey)) {
        ended = true;
        break;
      }
      previousFirstKey = firstKey;

      const contactable = rows.filter(isContactable);
      unusable += rows.length - contactable.length;
      result.droppedEnrichment += rows.length - contactable.length;
      // A page with no one to contact: the search has run past its complete
      // rows into name-only ones, and later pages hold more of the same.
      if (contactable.length === 0) {
        ended = true;
        break;
      }

      for (const person of contactable) {
        if (worked >= limit) {
          stop = true;
          break;
        }
        if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
          result.halted = `max-cost cap (${opts.maxCostUsd})`;
          stop = true;
          break;
        }
        const dedupeKey = candidateDedupeKey(person);
        // The per-title searches return people the combined one already did.
        if (seenThisRun.has(dedupeKey)) continue;
        seenThisRun.add(dedupeKey);
        if (dedupeScope.some((p) => ledger.isQueueDuplicate(p, dedupeKey))) {
          result.droppedDuplicate++;
          known++;
          continue;
        }
        // Only a new person counts toward the limit: people already in the
        // queue cost nothing to skip, and counting them stalled the finder
        // on its first page.
        worked++;
        fresh++;
        await workCandidate(person, personFullName(person), dedupeKey);
      }
      // Stopped part-way through the page: the search is not walked.
      if (stop) break;
      // A short page is the last one.
      if (rows.length < PEOPLE_SEARCH_LIMIT) ended = true;
      offset += rows.length;
    }
    // Walked to its end and everyone on it is already in the queue: leave it
    // alone for a while instead of paying to re-read the same people every
    // run. A search that returned no one usable is not marked: that is what a
    // platform outage looks like too, and it should be retried the next run.
    if (ended && fresh === 0 && known > 0 && !opts.dryRun) {
      ledger.setProductResearchCache(finishedKey, new Date().toISOString());
    }
  }

  if (!result.halted && result.candidates === 0) {
    result.halted =
      finishedQueries === queries.length
        ? "every search was walked to its end in the last 7 days: no one new to look at"
        : businessShaped
          ? "peopleSearch returned no matches for the resolved company domains"
          : "peopleSearch returned no matches — widen jobTitles/industries/locations";
  } else if (!result.halted && result.enqueued === 0 && unusable > 0) {
    result.halted = `${unusable} of ${result.candidates} search results had no last name or no company domain, profile or email, so there was no one to contact`;
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

/**
 * The `local` engine: one flat-priced `localSearch` (category × location),
 * then the domain-only contact spine per business. The same path
 * local-registry walks for a licence row, because a places result is the
 * same shape: a business with a domain and no owner name. Rows enqueue with
 * the `businessType` payload the free-pilot play, the ranking adapter and
 * the queue evidence renderer already branch on, so a local-engine row is
 * indistinguishable downstream from a B2B one.
 */
async function runLocalEngine(opts: LocalBusinessFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const industries = nonEmptyStrings(opts.industries);
  const locations = nonEmptyStrings(opts.locations);
  const yourEdge = (opts.yourEdge ?? "").trim();
  const route = resolvePlayRoute(opts);
  const dedupeScope = dedupePlayNames(PLAY_NAME);

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

  if (industries.length === 0 || locations.length === 0) {
    result.halted =
      'engine `local` needs `industries` (the category) and `locations` (city or "City, ST")';
    return result;
  }
  if (opts.maxCostUsd != null && opts.maxCostUsd <= 0) {
    result.halted = `max-cost cap (${opts.maxCostUsd})`;
    return result;
  }

  logEvent("finder.start", {
    name: PLAY_NAME,
    engine: "local",
    industries: industries.length,
    locations: locations.length,
    limit,
  });

  const search = await safeLocalSearch(
    {
      category: industries,
      location: locations,
      // A row has to be contactable to be worth a candidate slot, and a chain
      // is never an owner-operator buying a free pilot.
      hasDomain: true,
      isChain: false,
      operatingStatus: "open",
      limit: LOCAL_SEARCH_LIMIT,
    },
    { playName: PLAY_NAME },
  );
  result.costUsd += search.result.cost ?? 0;
  if (search.result.status === "error") {
    result.halted = "localSearch failed (platform error) — see logs";
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }
  const businesses = search.result.results as LocalResult[];
  result.candidates = businesses.length;
  if (businesses.length === 0) {
    result.halted = "localSearch returned no businesses — widen locations or try another category";
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }

  const fallbackBusinessType = industries.join(" / ");
  for (const biz of businesses) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    if (!biz || typeof biz !== "object") continue;
    const name = typeof biz.name === "string" ? biz.name.trim() : "";
    const domain = typeof biz.domain === "string" ? biz.domain.trim().toLowerCase() : "";
    if (!name || !domain) {
      result.droppedEnrichment++;
      continue;
    }
    // The SDK's `id` is a stable hash of normalized name + address. The
    // dedupe key it documents for exactly this cross-run purpose.
    const dedupeKey =
      typeof biz.id === "string" && biz.id
        ? `${PLAY_NAME}:local:${biz.id}`
        : `${PLAY_NAME}:local:${domain}`;
    const businessType = biz.category?.trim() || fallbackBusinessType;
    const city = locations[0] ?? null;

    if (dedupeScope.some((p) => ledger.isQueueDuplicate(p, dedupeKey))) {
      result.droppedDuplicate++;
      continue;
    }

    // ICP gate BEFORE any per-candidate paid call, as every finder does; the
    // search above was one flat call per run, so it isn't gated here.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: businessType,
        url: biz.website ?? undefined,
        summary: [name, businessType, biz.address].filter(Boolean).join(" · "),
      },
    });
    if (filter.match === null) {
      result.droppedEnrichment++;
      continue;
    }
    if (!filter.match) {
      result.droppedIcp++;
      if (!opts.dryRun) {
        ledger.enqueueTarget({
          playName: PLAY_NAME,
          payload: { name, company: name, title: null, businessType },
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

    // No owner name on a places result: findEmail resolves a company-level
    // address off the domain alone, the same opt-in local-registry uses.
    const contact = await resolveVerifyEnrichQualify({
      playName: PLAY_NAME,
      fullName: null,
      allowMissingFullName: true,
      companyDomain: domain,
      isDuplicate: (candEmail) =>
        isDuplicate({ playName: dedupeScope, dedupeKey, prospectEmail: candEmail }),
      icp,
      person: {
        name: null,
        company: name,
        evidence: `localSearch ${businessType}${city ? `, ${city}` : ""}`,
      },
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
          payload: { name, company: name, title: null, businessType },
          source: SOURCE,
          reason: contact.detail ?? "off-ICP role",
          dryRun: opts.dryRun,
        });
      } else result.droppedEnrichment++;
      continue;
    }

    const phone = contact.phone ?? biz.phone ?? null;
    const target = {
      name: contact.fullName ?? name,
      email: contact.email ?? "",
      company: name,
      businessType,
      yourEdge,
      ...(biz.address ? { address: biz.address } : {}),
      ...(city ? { city } : {}),
      ...(contact.linkedinUrl ? { linkedinUrl: contact.linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(contact.title ? { title: contact.title } : {}),
    };
    const id = enqueueScoredTarget(ledger, {
      playName: route ? route.playName : PLAY_NAME,
      payload: route
        ? buildDesignPartnerLoiPayload({
            name: target.name,
            email: target.email,
            company: name,
            buyerType: route.buyerType,
            yourEdge,
            title: contact.title,
            linkedinUrl: contact.linkedinUrl,
            phone,
            icp: icpFields(contact),
          })
        : target,
      dedupeKey,
      source: SOURCE,
      fitReason: filter.reason,
      notes: filter.reason,
      channel: contact.channel,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  logEvent("finder.done", {
    name: PLAY_NAME,
    engine: "local",
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
