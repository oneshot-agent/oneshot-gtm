import { logEvent } from "@oneshot-gtm/core";

/**
 * Pluggable source adapters for `local-registry` — keyless, free, public
 * JSON APIs that give the same thing `accelerator-batch`'s yc-oss adapter
 * gives for accelerators: a structured feed with a recency signal, no
 * per-record spend. See `local-registry.ts` for the per-candidate pipeline
 * these feed into.
 */

/** One entity discovered from a public local-business registry — before contact resolution. */
export interface RegistryRecord {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  /** ISO date the record matched on: license issue date (socrata) or NPI enumeration date (nppes). */
  matchedDateIso: string;
  source: "socrata-license" | "nppes";
  /** Human label for the specific portal/taxonomy this record came from — carried onto the queue row. */
  sourceLabel: string;
}

/** One Socrata open-data portal + dataset — exactly the shape issue #459 specifies. */
export interface SocrataPortalConfig {
  /** Socrata host, e.g. "data.cityofnewyork.us". No scheme. */
  host: string;
  /** Dataset 4x4 id, e.g. "w7w3-xahh". */
  dataset: string;
  /** Human label shown in queue notes + perSource outcomes. */
  label: string;
}

export interface RegistryQuery {
  /** Freshness window against the issue/enumeration date. */
  sinceDays: number;
  /** Max records this source should return, across all its portals/taxonomies. */
  limit: number;
  /** socrata-license only. */
  portals?: SocrataPortalConfig[];
  naics?: string[];
  licenseTypes?: string[];
  /** nppes only. */
  taxonomies?: string[];
  states?: string[];
}

export interface RegistryFetchOutcome {
  records: RegistryRecord[];
  costUsd: number;
  /** One entry per portal (socrata) or taxonomy×state pair (nppes) — mirrors accelerator-batch's perCohort. */
  perSource: Array<{ source: string; label: string; records: number; error?: string }>;
}

export interface RegistrySource {
  id: "socrata-license" | "nppes";
  fetch: (cfg: RegistryQuery) => Promise<RegistryFetchOutcome>;
}

// ---------------------------------------------------------------------------
// socrata-license
// ---------------------------------------------------------------------------

// Business-license open-data schemas vary portal to portal (no shared
// convention), so field extraction tries the common Socrata column names
// used across city/state license datasets rather than requiring the founder
// to map fields by hand for every portal they add.
const SOCRATA_NAME_FIELDS = [
  "business_name",
  "dba_name",
  "doing_business_as_name",
  "legal_name",
  "legal_business_name",
  "applicant_business_name",
  "entity_name",
  "name",
];
const SOCRATA_ADDRESS_FIELDS = ["address", "address_line_1", "premise_address", "business_address"];
const SOCRATA_CITY_FIELDS = ["city", "business_city", "city_name", "address_city"];
const SOCRATA_STATE_FIELDS = ["state", "business_state", "state_code", "address_state"];
const SOCRATA_PHONE_FIELDS = ["phone", "contact_phone", "business_phone", "telephone_number"];
const SOCRATA_DATE_FIELDS = [
  "license_creation_date",
  "issue_date",
  "issued_date",
  "effective_date",
  "date_issued",
  "license_issued_date",
  "certificate_issue_date",
  "created_date",
];

/** Case-sensitive then case-insensitive lookup across candidate field names. */
function pickField(record: Record<string, unknown>, candidates: string[]): string | null {
  for (const key of candidates) {
    const v = record[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  const lowerMap = new Map(Object.keys(record).map((k) => [k.toLowerCase(), k]));
  for (const key of candidates) {
    const actual = lowerMap.get(key.toLowerCase());
    if (!actual) continue;
    const v = record[actual];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function pickDateIso(record: Record<string, unknown>, candidates: string[]): string | null {
  const raw = pickField(record, candidates);
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Resolve a street address, preferring a single combined field but falling
 * back to composing `address_building` + `address_street_name` — the split
 * form several city portals (e.g. NYC's DCA license dataset) use instead of
 * one string field.
 */
function pickAddress(record: Record<string, unknown>): string | null {
  const direct = pickField(record, SOCRATA_ADDRESS_FIELDS);
  if (direct) return direct;
  const building = pickField(record, ["address_building"]);
  const street = pickField(record, ["address_street_name", "street_name"]);
  if (building && street) return `${building} ${street}`;
  return street ?? null;
}

/** Build the Socrata full-text `$q` term from naics/licenseTypes filters, or null when unfiltered. */
export function buildSocrataSearchTerm(
  naics: string[] | undefined,
  licenseTypes: string[] | undefined,
): string | null {
  const terms = [...(naics ?? []), ...(licenseTypes ?? [])].map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return null;
  return terms.join(" ");
}

/** Map + freshness-filter one portal's raw rows. Exported for the unit test's canned-payload check. */
export function mapSocrataRows(
  rows: unknown[],
  portalLabel: string,
  sinceDays: number,
): RegistryRecord[] {
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const out: RegistryRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const name = pickField(rec, SOCRATA_NAME_FIELDS);
    if (!name) continue;
    const matchedDateIso = pickDateIso(rec, SOCRATA_DATE_FIELDS);
    if (!matchedDateIso) continue;
    if (Date.parse(matchedDateIso) < sinceMs) continue;
    out.push({
      name,
      address: pickAddress(rec),
      city: pickField(rec, SOCRATA_CITY_FIELDS),
      state: pickField(rec, SOCRATA_STATE_FIELDS),
      phone: pickField(rec, SOCRATA_PHONE_FIELDS),
      matchedDateIso,
      source: "socrata-license",
      sourceLabel: portalLabel,
    });
  }
  return out;
}

async function fetchSocrataPortal(
  portal: SocrataPortalConfig,
  cfg: RegistryQuery,
): Promise<{ records: RegistryRecord[]; diagnostic: string | null }> {
  const params = new URLSearchParams();
  params.set("$limit", "200");
  const q = buildSocrataSearchTerm(cfg.naics, cfg.licenseTypes);
  if (q) params.set("$q", q);
  const url = `https://${portal.host}/resource/${portal.dataset}.json?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      records: [],
      diagnostic: `${portal.host} fetch failed: ${(err as Error).message ?? "network error"}`,
    };
  }
  if (!res.ok) {
    return { records: [], diagnostic: `${portal.host} returned ${res.status} ${res.statusText}` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { records: [], diagnostic: `${portal.host} response was not valid JSON` };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], diagnostic: `${portal.host} response was not an array` };
  }
  if (parsed.length === 0) {
    return { records: [], diagnostic: `${portal.host}/${portal.dataset} returned 0 rows` };
  }

  const records = mapSocrataRows(parsed, portal.label, cfg.sinceDays);
  if (records.length === 0) {
    return {
      records: [],
      diagnostic: `${portal.label}: ${parsed.length} rows fetched, none within ${cfg.sinceDays}d window`,
    };
  }
  return { records, diagnostic: null };
}

export const socrataLicenseSource: RegistrySource = {
  id: "socrata-license",
  async fetch(cfg) {
    const portals = cfg.portals ?? [];
    const perSource: RegistryFetchOutcome["perSource"] = [];
    const records: RegistryRecord[] = [];
    for (const portal of portals) {
      if (records.length >= cfg.limit) break;
      const tag = `${portal.host}/${portal.dataset}`;
      try {
        const outcome = await fetchSocrataPortal(portal, cfg);
        if (outcome.records.length === 0) {
          perSource.push({
            source: tag,
            label: portal.label,
            records: 0,
            error: outcome.diagnostic ?? "no records",
          });
          continue;
        }
        records.push(...outcome.records);
        perSource.push({ source: tag, label: portal.label, records: outcome.records.length });
      } catch (err) {
        const message = ((err as Error).message ?? "").slice(0, 120);
        logEvent(
          "error.swallowed",
          { kind: "local-registry.socrata_portal", portal: portal.host, message_120: message },
          "warn",
        );
        perSource.push({ source: tag, label: portal.label, records: 0, error: message });
      }
    }
    return { records: records.slice(0, cfg.limit), costUsd: 0, perSource };
  },
};

// ---------------------------------------------------------------------------
// nppes
// ---------------------------------------------------------------------------

interface NppesAddress {
  address_purpose?: string;
  address_1?: string;
  city?: string;
  state?: string;
  telephone_number?: string;
}
interface NppesBasic {
  organization_name?: string;
  first_name?: string;
  last_name?: string;
  enumeration_date?: string;
}
interface NppesResult {
  number?: string;
  basic?: NppesBasic;
  addresses?: NppesAddress[];
}
interface NppesResponse {
  result_count?: number;
  results?: NppesResult[];
}

function nppesDisplayName(basic: NppesBasic | undefined): string | null {
  if (!basic) return null;
  const org = basic.organization_name?.trim();
  if (org) return org;
  const parts = [basic.first_name, basic.last_name].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Map + freshness-filter one taxonomy×state pair's raw NPPES results. Exported for the unit test. */
export function mapNppesResults(
  results: NppesResult[],
  label: string,
  fallbackState: string,
  sinceDays: number,
): RegistryRecord[] {
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const out: RegistryRecord[] = [];
  for (const r of results) {
    const name = nppesDisplayName(r.basic);
    if (!name) continue;
    const enumDate = r.basic?.enumeration_date;
    if (!enumDate) continue;
    const t = Date.parse(enumDate);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const loc =
      (r.addresses ?? []).find((a) => a.address_purpose === "LOCATION") ?? r.addresses?.[0];
    out.push({
      name,
      address: loc?.address_1 ?? null,
      city: loc?.city ?? null,
      state: loc?.state ?? fallbackState,
      phone: loc?.telephone_number ?? null,
      matchedDateIso: new Date(t).toISOString(),
      source: "nppes",
      sourceLabel: label,
    });
  }
  return out;
}

async function fetchNppesPair(
  taxonomy: string,
  state: string,
  cfg: RegistryQuery,
): Promise<{ records: RegistryRecord[]; diagnostic: string | null }> {
  const params = new URLSearchParams({
    version: "2.1",
    taxonomy_description: taxonomy,
    state,
    limit: "200",
  });
  const url = `https://npiregistry.cms.hhs.gov/api/?${params.toString()}`;
  const label = `NPPES ${taxonomy} (${state})`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      records: [],
      diagnostic: `fetch failed: ${(err as Error).message ?? "network error"}`,
    };
  }
  if (!res.ok) {
    return { records: [], diagnostic: `nppes returned ${res.status} ${res.statusText}` };
  }
  let parsed: NppesResponse;
  try {
    parsed = (await res.json()) as NppesResponse;
  } catch {
    return { records: [], diagnostic: "nppes response was not valid JSON" };
  }
  const results = parsed.results ?? [];
  if (results.length === 0) {
    return { records: [], diagnostic: `nppes has no ${taxonomy} providers in ${state}` };
  }

  const records = mapNppesResults(results, label, state, cfg.sinceDays);
  if (records.length === 0) {
    return {
      records: [],
      diagnostic: `${label}: ${results.length} providers fetched, none within ${cfg.sinceDays}d window`,
    };
  }
  return { records, diagnostic: null };
}

export const nppesSource: RegistrySource = {
  id: "nppes",
  async fetch(cfg) {
    const taxonomies = cfg.taxonomies ?? [];
    const states = cfg.states ?? [];
    const perSource: RegistryFetchOutcome["perSource"] = [];
    const records: RegistryRecord[] = [];
    if (taxonomies.length === 0 || states.length === 0) {
      return { records: [], costUsd: 0, perSource: [] };
    }
    outer: for (const taxonomy of taxonomies) {
      for (const state of states) {
        if (records.length >= cfg.limit) break outer;
        const tag = `nppes:${taxonomy}:${state}`;
        const label = `NPPES ${taxonomy} (${state})`;
        try {
          const outcome = await fetchNppesPair(taxonomy, state, cfg);
          if (outcome.records.length === 0) {
            perSource.push({
              source: tag,
              label,
              records: 0,
              error: outcome.diagnostic ?? "no records",
            });
            continue;
          }
          records.push(...outcome.records);
          perSource.push({ source: tag, label, records: outcome.records.length });
        } catch (err) {
          const message = ((err as Error).message ?? "").slice(0, 120);
          logEvent(
            "error.swallowed",
            { kind: "local-registry.nppes_pair", taxonomy, state, message_120: message },
            "warn",
          );
          perSource.push({ source: tag, label, records: 0, error: message });
        }
      }
    }
    return { records: records.slice(0, cfg.limit), costUsd: 0, perSource };
  },
};

export const REGISTRY_SOURCES: RegistrySource[] = [socrataLicenseSource, nppesSource];
