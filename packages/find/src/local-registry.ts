import { getLedger, logEvent, type LocalResult } from "@oneshot-gtm/core";
import { resolveVerifyEnrichQualify, icpFields } from "./_contact.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection } from "./_qualify.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate } from "./_dedupe.ts";
import { parallelMap } from "./_parallel.ts";
import { safeLocalResolve } from "./_sdk-safe.ts";
import {
  REGISTRY_SOURCES,
  type FmcsaEntityType,
  type RegistryQuery,
  type RegistryRecord,
  type SocrataPortalConfig,
} from "./_registry-sources.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

/**
 * Local-business finder over free, keyless public registries: open-data
 * business licenses (Socrata), the NPPES NPI registry, and the FMCSA Company
 * Census (trucking/freight). The registries are the DISCOVERY step and stay
 * free: they are the only sources that carry a licence / enumeration /
 * registration date, which is what routes a row to `new-business` rather
 * than `free-pilot`. socrata-license/nppes give a business name + address but
 * no email — every such candidate resolves its domain via the SDK's
 * `localResolve` (name + the address the registry already handed us →
 * domain, phone, operating status) before falling through to the normal
 * `resolveVerifyEnrichQualify` spine, exactly like `accelerator-batch`'s
 * yc-oss records resolve a founder name before `findEmail`. fmcsa carries an
 * email ON the record — like `gov-solicitation` carries a published contact,
 * this skips resolution and `findEmail`/`verifyEmail` entirely rather than
 * paying to re-derive what the record already answers
 * (`RegistryRecord.knownEmail`).
 *
 * Recent-issue routing: a record inside `freshnessDays` of "now" is the
 * main-street equivalent of `post-funding` — nothing to rip out — and goes
 * to `new-business`; everything else goes to `free-pilot`. Same two-way
 * split `github-topics` does between stack-consolidation/competitor-switch.
 */
const SOURCE = "find:local-registry";
const NEW_BUSINESS_PLAY = "new-business";
const FREE_PILOT_PLAY = "free-pilot";

export interface LocalRegistryFinderOpts extends RunOpts {
  /** socrata-license source config. */
  portals?: SocrataPortalConfig[];
  naics?: string[];
  licenseTypes?: string[];
  /** nppes source config. */
  taxonomies?: string[];
  /** Two-letter state codes — shared by nppes (crossed with taxonomies) and fmcsa (filters phy_state). */
  states?: string[];
  /** fmcsa source config. Entity type filter: carrier / broker / freight-forwarder. */
  entityTypes?: FmcsaEntityType[];
  /** fmcsa source config. Fleet-size band — the 10-100 power-unit band is who actually buys software. */
  minPowerUnits?: number;
  maxPowerUnits?: number;
  /** Discovery window against the issue/enumeration/registration date. Default 60. */
  sinceDays?: number;
  /** Records matched inside this window route to new-business; older ones to free-pilot. Default 21, clamped to sinceDays. */
  freshnessDays?: number;
  /** Pitch angle for the main-street owner-operator. Required (readiness-gated). */
  yourEdge: string;
  /** Max in-flight candidate pipelines. Default 3. */
  concurrency?: number;
}

/** Payload shape enqueued for both `new-business` and `free-pilot` — the plays that consume it ship in #462. */
export interface LocalRegistryTarget {
  name: string;
  email: string;
  company: string;
  source: "socrata-license" | "nppes" | "fmcsa";
  sourceLabel: string;
  /** ISO issue/enumeration/registration date this record matched on — the trigger evidence. */
  matchedDateIso: string;
  yourEdge: string;
  /**
   * The three fields `free-pilot` / `new-business` REQUIRE (`requiredFields`
   * in packages/plays): without them `runEmailPlay` drops the row before the
   * LLM with "missing required field(s)", which is what every local-registry
   * row did until #498. Filled from the registry record when it says, else
   * from a per-source default that is at least true.
   */
  businessType: string;
  licenseType: string;
  /** "3 days ago", "2 weeks ago" — computed at enqueue time from `matchedDateIso`. */
  issuedAgo: string;
  /**
   * nppes only. Carried through from `RegistryRecord.subjectType` so a
   * `/queue` reviewer sees the same NPI-1 (individual) vs NPI-2
   * (organization) signal that explains why a "company" row shows a
   * person's name — see `_registry-sources.ts`'s `RegistryRecord` doc.
   */
  subjectType?: "individual" | "organization";
  /**
   * The registry's own name when `company` was replaced by the trade name
   * `localResolve` matched at the same address (see `pickResolvedBusiness`).
   */
  registryName?: string;
  address?: string;
  city?: string;
  state?: string;
  linkedinUrl?: string;
  phone?: string;
  title?: string;
}

/**
 * Unicode-preserving slug: lowercase, trim, drop apostrophes outright (no
 * separator), then collapse every remaining run of non-letter/non-number
 * characters (whitespace AND punctuation like "&") to a single hyphen
 * separator. `\p{L}`/`\p{N}` (not the old `a-z0-9` ASCII class) keep
 * non-Latin scripts intact — a Chinese or Cyrillic business name must not
 * collapse to the same empty string as every other non-ASCII name in the
 * run. Preserving a boundary at every OTHER punctuation run also keeps
 * "A&B Plumbing" distinct from "AB Plumbing" ("a-b-plumbing" vs
 * "ab-plumbing") — stripping "&" outright collapsed both to "ab-plumbing"
 * and silently dropped one as a duplicate of the other.
 *
 * Apostrophes are the one punctuation mark stripped WITHOUT a separator:
 * business names are spelled inconsistently across sources with vs.
 * without the possessive apostrophe ("Joe's Pizza" / "Joes Pizza",
 * "McDonald's" / "McDonalds"), and those variants must still collide to
 * the same dedupe key — both same-run cross-source dedup and the cross-run
 * ledger.isQueueDuplicate() check key off this slug, so a punctuation-only
 * spelling difference must not be treated as a new business.
 */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/['’`]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      // Single `-`, not `-+`: the collapse above already guarantees no run of
      // dashes survives, so the quantifier can never match more than one — and
      // `-+$` is a polynomial-ReDoS shape on a long dash string (CodeQL
      // js/polynomial-redos, flagged on this PR). Same output, no backtracking.
      .replace(/^-|-$/g, "")
  );
}

/** Stable within-run + cross-run dedupe key: name slug + state + city, source-agnostic.
 * Cross-source dedup is the stated intent (see the run-level dedupe below) —
 * a business appearing in both socrata-license and nppes must collapse to
 * one candidate, not be double-enriched and potentially double-queued. City
 * is included (address is not — its formatting varies too much between a
 * Socrata portal and NPPES to dedupe reliably) so two genuinely distinct
 * same-name businesses in a state-less or shared-state/city record don't
 * collapse into one candidate.
 */
export function dedupeKeyFor(record: RegistryRecord): string {
  const state = (record.state ?? "").toLowerCase().trim();
  const city = (record.city ?? "").toLowerCase().trim();
  return `${slugify(record.name)}:${state}:${city}`;
}

/**
 * Pick the business `localResolve` matched, or null. The SDK's own `found`
 * clears on a name-weighted threshold, and registry names are the wrong
 * kind of name for that: NPPES carries the LEGAL entity ("A PROFESSIONAL
 * DENTAL ORGANIZATION") or, for an NPI-1, the dentist's own name, while the
 * places index carries the TRADE name on the door ("Smiles at Telfair Family
 * and Cosmetic Dentistry"). Measured on real rows 2026-09-07: every miss came
 * back at 0.37–0.59 with a `closest_match` at the identical street number
 * and postal code. The address is the registry's own ground truth, so a
 * below-threshold candidate is accepted when the street number AND the
 * 5-digit postal code both agree — nothing looser, since a same-street
 * neighbour is exactly the wrong business to email.
 */
export function pickResolvedBusiness(
  record: Pick<RegistryRecord, "address" | "postalCode">,
  resolved: {
    found: boolean;
    result: LocalResult | null;
    closest_match?: LocalResult | undefined;
  },
): LocalResult | null {
  if (resolved.found && resolved.result) return resolved.result;
  const candidate = resolved.closest_match;
  if (!candidate?.address) return null;
  const streetNo = leadingStreetNumber(record.address);
  const zip5 = postalCode5(record.postalCode);
  if (!streetNo || !zip5) return null;
  return leadingStreetNumber(candidate.address) === streetNo && candidate.address.includes(zip5)
    ? candidate
    : null;
}

function leadingStreetNumber(address: string | null | undefined): string | null {
  const m = /^\s*(\d+[A-Za-z]?)\b/.exec(address ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/** NPPES publishes ZIP+4 without the hyphen ("774794629"); the index prints ZIP5. */
function postalCode5(postalCode: string | null | undefined): string | null {
  const digits = (postalCode ?? "").replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

/** What kind of business, when the registry row did not say. */
const DEFAULT_BUSINESS_TYPE: Record<RegistryRecord["source"], string> = {
  "socrata-license": "newly licensed local business",
  nppes: "healthcare practice",
  fmcsa: "motor carrier",
};

/** What was issued, when the registry row did not say. */
const DEFAULT_LICENSE_TYPE: Record<RegistryRecord["source"], string> = {
  "socrata-license": "business licence",
  nppes: "NPI enumeration",
  fmcsa: "USDOT motor carrier registration",
};

export function businessTypeFor(record: RegistryRecord): string {
  return record.businessType?.trim() || DEFAULT_BUSINESS_TYPE[record.source];
}

export function licenseTypeFor(record: RegistryRecord): string {
  return record.licenseType?.trim() || DEFAULT_LICENSE_TYPE[record.source];
}

/**
 * "today", "3 days ago", "2 weeks ago", "3 months ago" — the `issuedAgo` the
 * new-business prompt reads. Computed when the row is enqueued, so a row
 * that sits in /queue for a while reads slightly fresher than it is; the
 * matched date itself is on the payload for anyone who needs the exact day.
 */
export function issuedAgoLabel(matchedDateIso: string, now = Date.now()): string {
  const t = Date.parse(matchedDateIso);
  if (!Number.isFinite(t)) return "recently";
  const days = Math.max(0, Math.floor((now - t) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/** Recent-issue routing: fresh (within `freshnessDays`) → new-business, else → free-pilot. */
export function routePlayFor(matchedDateIso: string, freshnessDays: number): string {
  const cutoffMs = Date.now() - freshnessDays * 86_400_000;
  return Date.parse(matchedDateIso) >= cutoffMs ? NEW_BUSINESS_PLAY : FREE_PILOT_PLAY;
}

export async function runLocalRegistryFinder(opts: LocalRegistryFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const concurrency = opts.concurrency ?? 3;
  const sinceDays = Math.max(1, opts.sinceDays ?? 60);
  const freshnessDays = Math.min(Math.max(1, opts.freshnessDays ?? 21), sinceDays);
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  const query: RegistryQuery = {
    sinceDays,
    limit: limit * 2, // over-fetch a bit; ICP filter + dedupe + domain resolution winnow
    ...(opts.portals ? { portals: opts.portals } : {}),
    ...(opts.naics ? { naics: opts.naics } : {}),
    ...(opts.licenseTypes ? { licenseTypes: opts.licenseTypes } : {}),
    ...(opts.taxonomies ? { taxonomies: opts.taxonomies } : {}),
    ...(opts.states ? { states: opts.states } : {}),
    ...(opts.entityTypes ? { entityTypes: opts.entityTypes } : {}),
    ...(opts.minPowerUnits != null ? { minPowerUnits: opts.minPowerUnits } : {}),
    ...(opts.maxPowerUnits != null ? { maxPowerUnits: opts.maxPowerUnits } : {}),
  };

  // Step 1: fetch every configured source. Per-portal / per-taxonomy×state
  // isolation lives INSIDE each RegistrySource's own fetch (mirrors
  // accelerator-batch's per-cohort isolation) — a dead portal or an empty
  // taxonomy×state pair logs and continues; this run only halts when EVERY
  // configured source across every adapter returns 0.
  const sourceResults = await Promise.all(
    REGISTRY_SOURCES.map(async (src) => {
      try {
        return await src.fetch(query);
      } catch (err) {
        const message = ((err as Error).message ?? "").slice(0, 120);
        logEvent(
          "error.swallowed",
          { kind: "local-registry.source", source: src.id, message_120: message },
          "warn",
        );
        return {
          records: [] as RegistryRecord[],
          costUsd: 0,
          perSource: [{ source: src.id, label: src.id, records: 0, error: message }],
        };
      }
    }),
  );

  const allRecords: RegistryRecord[] = [];
  const perSource: NonNullable<FinderResult["perSource"]> = [];
  for (const r of sourceResults) {
    allRecords.push(...r.records);
    perSource.push(...r.perSource);
    result.costUsd += r.costUsd;
  }
  result.perSource = perSource;

  // Dedupe across sources within this run before touching the queue —
  // NY state + NYC-city portals commonly double-publish the same license.
  // Keep the record with the LATEST matchedDateIso, not just the first one
  // seen: source fetch order (socrata before nppes, see REGISTRY_SOURCES)
  // must not decide routing. An older socrata license row must not suppress
  // a newer NPPES enumeration and wrongly route the business to free-pilot
  // instead of new-business.
  const seen = new Map<string, number>();
  const deduped: RegistryRecord[] = [];
  for (const r of allRecords) {
    const key = dedupeKeyFor(r);
    const priorIndex = seen.get(key);
    if (priorIndex !== undefined) {
      if (Date.parse(r.matchedDateIso) > Date.parse(deduped[priorIndex]!.matchedDateIso)) {
        deduped[priorIndex] = r;
      }
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push(r);
  }
  result.candidates = deduped.length;

  if (deduped.length === 0) {
    const detail =
      perSource.length > 0
        ? perSource.map((p) => `${p.label}: ${p.error ?? "0 records"}`).join("; ")
        : "no sources configured";
    result.halted = `every configured source returned 0 records — ${detail}`;
    return result;
  }

  let halted = false;
  // Reserve a slot the moment a worker commits to processing a record —
  // BEFORE its own paid calls run — not after. Checking `result.enqueued`
  // (mutated only once a candidate fully clears every gate) lets multiple
  // in-flight workers all see it below `limit` and all proceed: with
  // `limit:1, concurrency:3`, all three could enqueue before the first one's
  // async pipeline finishes and bumps the counter. `reserved` is bumped
  // synchronously (no `await` before the increment), so it caps how many
  // pipelines are ever launched, independent of completion order.
  let reserved = 0;

  await parallelMap(deduped, concurrency, async (record) => {
    if (halted) return;
    if (reserved >= limit) {
      result.halted = `limit (${limit}) reached`;
      halted = true;
      return;
    }
    reserved++;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      halted = true;
      return;
    }

    const dedupeKey = dedupeKeyFor(record);
    const playName = routePlayFor(record.matchedDateIso, freshnessDays);
    if (
      ledger.isQueueDuplicate(NEW_BUSINESS_PLAY, dedupeKey) ||
      ledger.isQueueDuplicate(FREE_PILOT_PLAY, dedupeKey)
    ) {
      result.droppedDuplicate++;
      // No paid call ran for this record — release the slot instead of
      // spending it, or a tick full of prior-run duplicates (the common
      // steady-state case: isQueueDuplicate matches rows from every past
      // run) starves the fresh candidates behind them (finding
      // PRRT_kwDOSKzrBs6fCBdz).
      reserved--;
      return;
    }

    if (opts.dryRun) {
      result.enqueued++;
      return;
    }

    // ICP filter — cheapest gate first, BEFORE any paid call (enrichCompany
    // included), as every sibling finder does.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: record.name,
        url: null,
        summary: buildIcpSummary(record),
      },
    });
    if (filter.match === null) {
      // Transient classifier failure — drop without persisting. A rejection
      // would burn the dedupeKey forever (isQueueDuplicate ignores status).
      result.droppedEnrichment++;
      return;
    }
    if (!filter.match) {
      result.droppedIcp++;
      ledger.enqueueTarget({
        playName,
        payload: rejectionPayload(record),
        dedupeKey,
        source: SOURCE,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      return;
    }

    // Resolve a domain — the registries carry a name and address, never a
    // website. `localResolve` is built for exactly that pair: name plus the
    // locating fields the record already has → domain, phone and whether the
    // place is still operating (which is also what the health-inspection
    // lane used to exist to confirm). fmcsa is the one source that already
    // carries a published email on the record (like gov-solicitation's
    // contracting-officer contact) — paying to re-derive a domain the record
    // never needed is exactly the spend to skip.
    let domain: string | null = null;
    let resolvedPhone: string | null = null;
    let tradeName: string | null = null;
    if (!record.knownEmail) {
      const resolved = await safeLocalResolve(
        {
          name: record.name,
          ...(record.address ? { address: record.address } : {}),
          ...(record.city ? { city: record.city } : {}),
          ...(record.state ? { region: record.state } : {}),
          ...(record.postalCode ? { postalCode: record.postalCode } : {}),
          ...(record.phone ? { phone: record.phone } : {}),
        },
        { playName },
      );
      result.costUsd += resolved.result.cost ?? 0;
      const match = pickResolvedBusiness(record, resolved.result);
      if (!match?.domain) {
        result.droppedEnrichment++;
        return;
      }
      if (match.operating_status === "closed") {
        // A licence row for a place that has since shut is not a prospect.
        result.droppedEnrichment++;
        return;
      }
      domain = match.domain;
      resolvedPhone = match.phone ?? null;
      // The name on the door is the one to write to; the registry's legal
      // or individual name stays on the row as provenance.
      if (match.name && match.name.trim() && match.name.trim() !== record.name) {
        tradeName = match.name.trim();
      }
    }

    // Recheck the cap after localResolve's paid call and before
    // resolveVerifyEnrichQualify's own paid calls (findEmail/verifyEmail/
    // enrich/qualify — up to 4 more). The top-of-turn check above only
    // guards entry to a candidate's turn; concurrent workers can each pass
    // it at the same accumulated cost and then all incur enrichCompany +
    // contact-resolution spend before the next candidate's pre-check
    // catches it (finding PRRT_kwDOSKzrBs6exPH4). This narrows, not
    // eliminates, the overshoot window — the alternative (a hard
    // reservation) would require threading a lock through every paid call
    // this spine makes, a bigger change than a correction round justifies.
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      halted = true;
      return;
    }

    const contact = await resolveVerifyEnrichQualify({
      playName,
      // No owner/operator name in any registry — findEmail resolves a
      // company-level address off the domain alone (fullName is optional on
      // the SDK call; allowMissingFullName opts into that instead of the
      // prescreen's default "no name = probably a bad extraction" rejection).
      fullName: null,
      allowMissingFullName: true,
      ...(record.knownEmail ? { knownEmail: record.knownEmail } : { companyDomain: domain }),
      // fmcsa's knownEmail is USDOT's own on-file carrier contact address —
      // a federal registration field, not a scraped/guessed one — so paying
      // to re-verify what the record already asserts is exactly the spend
      // this card says to skip (mirrors knownEmail already skipping
      // findEmail above). Has no effect for socrata-license/nppes/
      // socrata-license/nppes records, which never carry knownEmail and always
      // go through the normal companyDomain + verify path.
      skipVerify: record.source === "fmcsa",
      isDuplicate: (email) => isDuplicate({ playName, dedupeKey, prospectEmail: email }),
      errKindPrefix: "local-registry",
      icp,
      person: {
        name: null,
        company: tradeName ?? record.name,
        evidence: `${record.sourceLabel}, matched ${record.matchedDateIso.slice(0, 10)}`,
      },
      fillGaps: opts.qualifyFillGaps ?? true,
    });
    result.costUsd += contact.costUsd;
    if (!contact.ok) {
      if (contact.reason === "duplicate") result.droppedDuplicate++;
      else if (contact.reason === "role") {
        result.droppedRole = (result.droppedRole ?? 0) + 1;
        persistRoleRejection({
          playName,
          dedupeKey,
          payload: rejectionPayload(record),
          source: SOURCE,
          reason: contact.detail ?? "off-ICP role",
          dryRun: opts.dryRun,
        });
      } else result.droppedEnrichment++;
      return;
    }

    // Recheck the cap immediately before the synchronous enqueue call: the
    // top-of-turn check above ran before this candidate's own async work
    // (icpFilter/enrichCompany/resolveVerifyEnrichQualify), so with
    // concurrency > 1 multiple workers can pass that check together and
    // each still be racing toward enqueueScoredTarget when `limit` is
    // small (e.g. 1) — only the first to reach this point should win.
    if (result.enqueued >= limit) {
      halted = true;
      return;
    }

    const phone = contact.phone ?? resolvedPhone ?? record.phone ?? null;
    const target: LocalRegistryTarget = {
      name: contact.fullName ?? tradeName ?? record.name,
      email: contact.email,
      company: tradeName ?? record.name,
      ...(tradeName ? { registryName: record.name } : {}),
      source: record.source,
      sourceLabel: record.sourceLabel,
      matchedDateIso: record.matchedDateIso,
      yourEdge: opts.yourEdge,
      businessType: businessTypeFor(record),
      licenseType: licenseTypeFor(record),
      issuedAgo: issuedAgoLabel(record.matchedDateIso),
      ...(record.subjectType ? { subjectType: record.subjectType } : {}),
      ...(record.postalCode ? { postalCode: record.postalCode } : {}),
      ...(record.address ? { address: record.address } : {}),
      ...(record.city ? { city: record.city } : {}),
      ...(record.state ? { state: record.state } : {}),
      ...(contact.linkedinUrl ? { linkedinUrl: contact.linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(contact.title ? { title: contact.title } : {}),
      ...icpFields(contact),
    };
    const id = enqueueScoredTarget(ledger, {
      playName,
      payload: target,
      dedupeKey,
      source: SOURCE,
      fitReason: filter.reason,
      notes: `${record.sourceLabel} — ${filter.reason}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  });

  return result;
}

function buildIcpSummary(record: RegistryRecord): string {
  const loc = [record.city, record.state].filter(Boolean).join(", ");
  return `${record.name} — ${record.sourceLabel}${loc ? `, ${loc}` : ""}. Matched on ${record.matchedDateIso.slice(0, 10)}.`;
}

function rejectionPayload(record: RegistryRecord): Record<string, unknown> {
  return {
    company: record.name,
    source: record.source,
    sourceLabel: record.sourceLabel,
    matchedDateIso: record.matchedDateIso,
    ...(record.address ? { address: record.address } : {}),
  };
}
