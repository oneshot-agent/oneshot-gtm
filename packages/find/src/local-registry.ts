import { getLedger, logEvent } from "@oneshot-gtm/core";
import { resolveVerifyEnrichQualify } from "./_contact.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection } from "./_qualify.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate } from "./_dedupe.ts";
import { parallelMap } from "./_parallel.ts";
import { safeEnrichCompany } from "./_sdk-safe.ts";
import {
  REGISTRY_SOURCES,
  type FmcsaEntityType,
  type RegistryQuery,
  type RegistryRecord,
  type SocrataInspectionPortalConfig,
  type SocrataPortalConfig,
} from "./_registry-sources.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

/**
 * Local-business finder over free, keyless public registries: open-data
 * business licenses (Socrata), the NPPES NPI registry, the FMCSA Company
 * Census (trucking/freight), and city health-inspection open data (Socrata).
 * socrata-license/nppes give a business name + address but no email — every
 * such candidate resolves its domain via `enrichCompany` before falling
 * through to the normal `resolveVerifyEnrichQualify` spine, exactly like
 * `accelerator-batch`'s yc-oss records resolve a founder name before
 * `findEmail`. fmcsa carries an email ON the record — like `gov-solicitation`
 * carries a verified SAM.gov contact address, this skips `findEmail`/
 * `verifyEmail` entirely rather than paying to re-derive what the record
 * already answers (`RegistryRecord.knownEmail`). socrata-inspection records
 * carry no contact info at all and are consumed as a recency/operating-status
 * confirmation joined to the licence lane, not standalone.
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
  /** socrata-inspection source config. Named distinctly from `portals` (socrata-license's own list) since both adapters share this one trigger config. */
  inspectionPortals?: SocrataInspectionPortalConfig[];
  /** Discovery window against the issue/enumeration/registration/inspection date. Default 60. */
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
  source: "socrata-license" | "nppes" | "fmcsa" | "socrata-inspection";
  sourceLabel: string;
  /** ISO issue/enumeration/registration/inspection date this record matched on — the trigger evidence. */
  matchedDateIso: string;
  yourEdge: string;
  address?: string;
  city?: string;
  state?: string;
  linkedinUrl?: string;
  phone?: string;
  title?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Stable within-run + cross-run dedupe key: source + name slug + state. */
export function dedupeKeyFor(record: RegistryRecord): string {
  return `${record.source}:${slugify(record.name)}:${(record.state ?? "").toLowerCase()}`;
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
    ...(opts.inspectionPortals ? { inspectionPortals: opts.inspectionPortals } : {}),
  };

  // Step 1: fetch every configured source. Per-portal / per-taxonomy×state
  // isolation lives INSIDE each RegistrySource's own fetch (mirrors
  // accelerator-batch's per-cohort isolation) — a dead portal or an empty
  // taxonomy×state pair logs and continues; this run only halts when EVERY
  // configured source across BOTH adapters returns 0.
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
  const seen = new Set<string>();
  const deduped: RegistryRecord[] = [];
  for (const r of allRecords) {
    const key = dedupeKeyFor(r);
    if (seen.has(key)) continue;
    seen.add(key);
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

  await parallelMap(deduped, concurrency, async (record) => {
    if (halted) return;
    if (result.enqueued >= limit) {
      halted = true;
      return;
    }
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

    // Resolve a domain from the business name — the registries carry a name
    // and address, never a website. #456's enrichCompany ($0.005) is the
    // cheapest resolver in the toolbox for that. fmcsa is the one source
    // that already carries a published email on the record (like
    // gov-solicitation's SAM.gov contact) — paying to re-derive a domain the
    // record never needed is exactly the spend this card says to skip.
    let domain: string | null = null;
    if (!record.knownEmail) {
      const enriched = await safeEnrichCompany({ name: record.name }, { playName });
      result.costUsd += enriched.result.cost ?? 0;
      domain = enriched.result.company?.domain ?? null;
      if (!domain) {
        result.droppedEnrichment++;
        return;
      }
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
      isDuplicate: (email) => isDuplicate({ playName, dedupeKey, prospectEmail: email }),
      errKindPrefix: "local-registry",
      icp,
      person: {
        name: null,
        company: record.name,
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

    const phone = contact.phone ?? record.phone ?? null;
    const target: LocalRegistryTarget = {
      name: contact.fullName ?? record.name,
      email: contact.email,
      company: record.name,
      source: record.source,
      sourceLabel: record.sourceLabel,
      matchedDateIso: record.matchedDateIso,
      yourEdge: opts.yourEdge,
      ...(record.address ? { address: record.address } : {}),
      ...(record.city ? { city: record.city } : {}),
      ...(record.state ? { state: record.state } : {}),
      ...(contact.linkedinUrl ? { linkedinUrl: contact.linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(contact.title ? { title: contact.title } : {}),
    };
    const id = enqueueScoredTarget(ledger, {
      playName,
      payload: target,
      dedupeKey,
      source: SOURCE,
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
