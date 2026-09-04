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
  /**
   * ISO date the record matched on: license issue date (socrata-license),
   * NPI enumeration date (nppes), USDOT registration date (fmcsa), or
   * inspection date (socrata-inspection).
   */
  matchedDateIso: string;
  source: "socrata-license" | "nppes" | "fmcsa" | "socrata-inspection";
  /** Human label for the specific portal/taxonomy this record came from — carried onto the queue row. */
  sourceLabel: string;
  /**
   * nppes only. NPPES enumerates two distinct subject types under one API:
   * NPI-1 (individual — `name` is a person's first+last) vs NPI-2
   * (organization — `name` is the business/org name). Both get billed
   * downstream to `enrichCompany` as if `name` were a company name, so this
   * flag lets a reviewer of `/queue` rows tell why a "company" row shows a
   * person's name instead of assuming a mapping bug.
   */
  subjectType?: "individual" | "organization";
  /**
   * The record's own on-file email (fmcsa only) — carries a published email,
   * so the caller skips `findEmail`/`verifyEmail` entirely for this
   * candidate rather than paying to re-derive what the record already
   * answers. Null/absent for every other source.
   */
  knownEmail?: string | null;
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

/** One Socrata health-inspection portal + dataset — issue #460's `socrata-inspection` config shape. */
export interface SocrataInspectionPortalConfig {
  /** Socrata host, e.g. "data.cityofnewyork.us". No scheme. */
  host: string;
  /** Dataset 4x4 id, e.g. "43nn-pn8j" (NYC restaurant inspections). */
  dataset: string;
  /** Human label shown in queue notes + perSource outcomes. */
  label: string;
  /**
   * Column this portal's inspection date lives under — matches one of
   * INSPECTION_DATE_FIELDS ("inspection_date" | "date" | "activity_date").
   * Defaults to "inspection_date". The mapper already falls back across all
   * three names locally, but the Socrata `$order` clause sent on the wire
   * has to name one column that actually exists on the portal or the API
   * 400s before any row comes back — so a portal using an alternate schema
   * must declare it here.
   */
  dateField?: string;
}

export interface RegistryQuery {
  /** Freshness window against the issue/enumeration/registration/inspection date. */
  sinceDays: number;
  /** Max records this source should return, across all its portals/taxonomies. */
  limit: number;
  /** socrata-license only. */
  portals?: SocrataPortalConfig[];
  naics?: string[];
  licenseTypes?: string[];
  /** nppes + fmcsa. Two-letter state codes — crossed with taxonomies (nppes) or filtering phy_state (fmcsa). */
  taxonomies?: string[];
  states?: string[];
  /** fmcsa only. Entity type(s): "carrier" | "broker" | "freight-forwarder", matched against `carship`. */
  entityTypes?: FmcsaEntityType[];
  /** fmcsa only. Fleet-size floor/ceiling on `power_units` — the 10-100 band is who actually buys software. */
  minPowerUnits?: number;
  maxPowerUnits?: number;
  /** socrata-inspection only. */
  inspectionPortals?: SocrataInspectionPortalConfig[];
}

export interface RegistryFetchOutcome {
  records: RegistryRecord[];
  costUsd: number;
  /** One entry per portal (socrata) or taxonomy×state pair (nppes) — mirrors accelerator-batch's perCohort. */
  perSource: Array<{ source: string; label: string; records: number; error?: string }>;
}

export interface RegistrySource {
  id: "socrata-license" | "nppes" | "fmcsa" | "socrata-inspection";
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

/**
 * Which of the known date-column spellings this specific portal's schema
 * actually uses — needed so pagination can `$order`/`$where` on a real
 * SoQL column name. Returns the ACTUAL key (not the value), unlike
 * `pickField`, and doesn't require the value to be present on this one row.
 */
function findDateFieldKey(record: Record<string, unknown>, candidates: string[]): string | null {
  for (const key of candidates) {
    if (key in record) return key;
  }
  const lowerMap = new Map(Object.keys(record).map((k) => [k.toLowerCase(), k]));
  for (const key of candidates) {
    const actual = lowerMap.get(key.toLowerCase());
    if (actual) return actual;
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

const SOCRATA_PAGE_SIZE = 200;
/**
 * Cap on pages fetched per portal per run (1,000 rows @ 200/page). Recency
 * ordering + a server-side date predicate mean this ceiling is now about
 * bounding request volume/cost, not about correctness — unlike the old
 * unordered single page, every row considered here is guaranteed to be
 * within the freshness window and returned newest-first.
 */
const SOCRATA_MAX_PAGES = 5;

/**
 * Resolve this portal's date column from the dataset's own column metadata
 * (Socrata's `/api/views/{4x4}.json`), which lists every column by name
 * regardless of whether any single row happens to have a value in it. A
 * one-row `$limit=1` probe can omit the date field entirely on a
 * sparsely-populated dataset (or just an unlucky row) and wrongly report "no
 * date column" even though the column exists and is populated on the vast
 * majority of rows. Returns null (never throws) so the caller can fall back.
 */
async function resolveSocrataDateFieldFromMetadata(
  portal: SocrataPortalConfig,
): Promise<string | null> {
  try {
    const metaUrl = `https://${portal.host}/api/views/${portal.dataset}.json`;
    const res = await fetch(metaUrl);
    if (!res.ok) return null;
    const meta = (await res.json()) as { columns?: Array<{ fieldName?: unknown }> };
    const fieldNames = (meta.columns ?? [])
      .map((c) => c.fieldName)
      .filter((f): f is string => typeof f === "string" && f.length > 0);
    if (fieldNames.length === 0) return null;
    const lowerMap = new Map(fieldNames.map((f) => [f.toLowerCase(), f]));
    for (const candidate of SOCRATA_DATE_FIELDS) {
      const actual = lowerMap.get(candidate.toLowerCase());
      if (actual) return actual;
    }
    return null;
  } catch {
    return null;
  }
}
async function fetchSocrataPortal(
  portal: SocrataPortalConfig,
  cfg: RegistryQuery,
): Promise<{ records: RegistryRecord[]; diagnostic: string | null }> {
  const q = buildSocrataSearchTerm(cfg.naics, cfg.licenseTypes);

  // Business-license schemas vary portal to portal (see SOCRATA_DATE_FIELDS).
  // Prefer the dataset's own column metadata — it names every column
  // regardless of row-level nulls — and fall back to a single cheap probe
  // row only when the metadata call itself is unavailable. Either way, the
  // resolved column is required for both `$order` (recency-first) and
  // `$where` (server-side freshness predicate) below.
  let dateField: string | null = await resolveSocrataDateFieldFromMetadata(portal);
  if (!dateField) {
    const probeParams = new URLSearchParams();
    probeParams.set("$limit", "1");
    if (q) probeParams.set("$q", q);
    const probeUrl = `https://${portal.host}/resource/${portal.dataset}.json?${probeParams.toString()}`;
    try {
      const probeRes = await fetch(probeUrl);
      if (probeRes.ok) {
        const probeRows = await probeRes.json();
        const probeRow =
          Array.isArray(probeRows) && probeRows.length > 0 && typeof probeRows[0] === "object"
            ? (probeRows[0] as Record<string, unknown>)
            : null;
        if (probeRow) dateField = findDateFieldKey(probeRow, SOCRATA_DATE_FIELDS);
      }
    } catch {
      // Schema probe is best-effort: fall through without ordering rather than
      // failing the whole portal — the main fetch below still runs.
    }
  }
  const sinceIso = new Date(Date.now() - cfg.sinceDays * 86_400_000).toISOString().split(".")[0];

  const rows: unknown[] = [];
  for (let page = 0; page < SOCRATA_MAX_PAGES; page++) {
    const params = new URLSearchParams();
    params.set("$limit", String(SOCRATA_PAGE_SIZE));
    params.set("$offset", String(page * SOCRATA_PAGE_SIZE));
    if (q) params.set("$q", q);
    if (dateField) {
      // Recency-first ordering + a server-side freshness predicate — without
      // this, `$limit=200` with no `$order` returns an arbitrary page of a
      // dataset that can be millions of rows, silently missing every
      // qualifying recent row that lands outside that arbitrary page.
      params.set("$order", `${dateField} DESC`);
      params.set("$where", `${dateField} >= '${sinceIso}'`);
    }
    const url = `https://${portal.host}/resource/${portal.dataset}.json?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (page === 0) {
        return {
          records: [],
          diagnostic: `${portal.host} fetch failed: ${(err as Error).message ?? "network error"}`,
        };
      }
      break;
    }
    if (!res.ok) {
      if (page === 0) {
        return {
          records: [],
          diagnostic: `${portal.host} returned ${res.status} ${res.statusText}`,
        };
      }
      break;
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      if (page === 0) {
        return { records: [], diagnostic: `${portal.host} response was not valid JSON` };
      }
      break;
    }
    if (!Array.isArray(parsed)) {
      if (page === 0) {
        return { records: [], diagnostic: `${portal.host} response was not an array` };
      }
      break;
    }
    if (parsed.length === 0) break;
    rows.push(...parsed);
    if (parsed.length < SOCRATA_PAGE_SIZE) break; // last page
  }

  if (rows.length === 0) {
    return { records: [], diagnostic: `${portal.host}/${portal.dataset} returned 0 rows` };
  }

  const records = mapSocrataRows(rows, portal.label, cfg.sinceDays);
  if (records.length === 0) {
    return {
      records: [],
      diagnostic: `${portal.label}: ${rows.length} rows fetched, none within ${cfg.sinceDays}d window`,
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

/** NPI-2 (organization) has `organization_name` set; NPI-1 (individual) does not. */
function nppesSubjectType(basic: NppesBasic | undefined): "individual" | "organization" {
  return basic?.organization_name?.trim() ? "organization" : "individual";
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
      subjectType: nppesSubjectType(r.basic),
    });
  }
  return out;
}

const NPPES_PAGE_SIZE = 200;
/** NPPES's own documented ceiling: skip caps at 1000, so 6 pages of 200 (1200 records) is the max obtainable for any one query — matches the ropensci npi_search client's documented limit. */
const NPPES_MAX_PAGES = 6;
async function fetchNppesPair(
  taxonomy: string,
  state: string,
  cfg: RegistryQuery,
): Promise<{ records: RegistryRecord[]; diagnostic: string | null }> {
  const label = `NPPES ${taxonomy} (${state})`;
  const results: NppesResult[] = [];

  for (let page = 0; page < NPPES_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      version: "2.1",
      taxonomy_description: taxonomy,
      state,
      limit: String(NPPES_PAGE_SIZE),
      skip: String(page * NPPES_PAGE_SIZE),
    });
    const url = `https://npiregistry.cms.hhs.gov/api/?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (page === 0) {
        return {
          records: [],
          diagnostic: `fetch failed: ${(err as Error).message ?? "network error"}`,
        };
      }
      break;
    }
    if (!res.ok) {
      if (page === 0) {
        return { records: [], diagnostic: `nppes returned ${res.status} ${res.statusText}` };
      }
      break;
    }
    let parsed: NppesResponse;
    try {
      parsed = (await res.json()) as NppesResponse;
    } catch {
      if (page === 0) {
        return { records: [], diagnostic: "nppes response was not valid JSON" };
      }
      break;
    }
    const pageResults = parsed.results ?? [];
    if (pageResults.length === 0) break;
    // NPPES has no `$order`-equivalent sort param (confirmed against the
    // API's own field reference: only `limit`/`skip`), so walking every
    // page up to the 1,200-record ceiling closes the gap ONLY when a
    // taxonomy×state pair's total result count is <=1200. A pair that
    // exceeds that (e.g. Dentist in a populous state like CA/TX/NY) can
    // still leave a newly-enumerated provider past page 6 invisible —
    // there is no ordering guarantee to bring it forward, unlike the
    // Socrata fix's server-side $order+$where. See STATUS.md's known
    // limitations for the honest statement of what this does and doesn't
    // cover.
    results.push(...pageResults);
    if (pageResults.length < NPPES_PAGE_SIZE) break; // last page
  }
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

// ---------------------------------------------------------------------------
// fmcsa — Company Census File, data.transportation.gov/resource/az4n-8mr2
// ---------------------------------------------------------------------------

/** FMCSA `carship` letter codes: C=Carrier, B=Broker, F=Freight Forwarder. */
export type FmcsaEntityType = "carrier" | "broker" | "freight-forwarder";

const FMCSA_ENTITY_LETTERS: Record<FmcsaEntityType, string> = {
  carrier: "C",
  broker: "B",
  "freight-forwarder": "F",
};

/**
 * FMCSA add_date ("YYYYMMDD") → ISO. Registration dates predate ISO
 * timestamps entirely, so this is a plain string-slice parse, not
 * `Date.parse` (which chokes on a bare "YYYYMMDD" in some engines).
 */
function fmcsaDateIso(raw: string | undefined): string | null {
  if (!raw || raw.length < 8) return null;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const t = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/** Inverse of `fmcsaDateIso`'s slicing: a Date → FMCSA's zero-padded "YYYYMMDD" string, UTC. */
function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Build the FMCSA `$where` clause from entity type / state / power-unit / freshness filters. */
export function buildFmcsaWhere(cfg: RegistryQuery): string {
  const clauses: string[] = ["status_code='A'", "email_address IS NOT NULL"];
  // `add_date` is a zero-padded "YYYYMMDD" string column, so a lexical `>=`
  // comparison against another zero-padded "YYYYMMDD" string sorts/filters
  // identically to a numeric/date comparison. Without this, $where never
  // touches add_date at all and Socrata's default row order has no
  // relationship to it — against the ~2.2M-row active-carrier table, the
  // first $limit rows returned almost never fall inside `sinceDays`, so
  // the local freshness filter in `mapFmcsaRows` silently drops everything.
  const sinceDate = new Date(Date.now() - cfg.sinceDays * 86_400_000);
  clauses.push(`add_date>='${yyyymmdd(sinceDate)}'`);
  const entityTypes = cfg.entityTypes ?? [];
  if (entityTypes.length > 0) {
    const letters = entityTypes.map((t) => FMCSA_ENTITY_LETTERS[t]);
    clauses.push(`(${letters.map((l) => `carship like '%${l}%'`).join(" OR ")})`);
  }
  const states = cfg.states ?? [];
  if (states.length > 0) {
    clauses.push(`phy_state in(${states.map((s) => `'${s.toUpperCase()}'`).join(",")})`);
  }
  if (typeof cfg.minPowerUnits === "number") {
    clauses.push(`power_units::number>=${cfg.minPowerUnits}`);
  }
  if (typeof cfg.maxPowerUnits === "number") {
    clauses.push(`power_units::number<=${cfg.maxPowerUnits}`);
  }
  return clauses.join(" AND ");
}

/** Map + freshness-filter one page of FMCSA rows. Exported for the unit test's canned-payload check. */
export function mapFmcsaRows(rows: unknown[], sinceDays: number): RegistryRecord[] {
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const out: RegistryRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec["legal_name"] === "string" ? rec["legal_name"].trim() : "";
    if (!name) continue;
    const email = typeof rec["email_address"] === "string" ? rec["email_address"].trim() : "";
    if (!email || !email.includes("@")) continue;
    const matchedDateIso = fmcsaDateIso(
      typeof rec["add_date"] === "string" ? rec["add_date"] : undefined,
    );
    if (!matchedDateIso) continue;
    if (Date.parse(matchedDateIso) < sinceMs) continue;
    const street = typeof rec["phy_street"] === "string" ? rec["phy_street"].trim() : null;
    const city = typeof rec["phy_city"] === "string" ? rec["phy_city"].trim() : null;
    const state = typeof rec["phy_state"] === "string" ? rec["phy_state"].trim() : null;
    const phone = typeof rec["phone"] === "string" ? rec["phone"].trim() : null;
    out.push({
      name,
      address: street && street.length > 0 ? street : null,
      city: city && city.length > 0 ? city : null,
      state: state && state.length > 0 ? state : null,
      phone: phone && phone.length > 0 ? phone : null,
      matchedDateIso,
      source: "fmcsa",
      sourceLabel: "FMCSA Company Census",
      knownEmail: email.toLowerCase(),
    });
  }
  return out;
}

export const fmcsaSource: RegistrySource = {
  id: "fmcsa",
  async fetch(cfg) {
    // Mirror nppesSource's empty-config guard (line ~415 above): without at
    // least one FMCSA-specific filter, buildFmcsaWhere still yields a valid
    // non-empty $where (active status + published email + freshness) that
    // queries the full nationwide ~2.2M-row trucking dataset. A trigger
    // configured for socrata-license/socrata-inspection/nppes only — never
    // touching fmcsa's own config keys — must not silently fire this query
    // and enqueue unrelated trucking carriers. `states` is deliberately
    // EXCLUDED here: it's shared with nppes (crossed with taxonomies), so an
    // NPPES-only config (taxonomies + states, no fmcsa-specific key) must not
    // enable fmcsa just because `states` is also set — matches registry.ts's
    // `readiness` hasFmcsa check, which already excludes it for the same
    // reason. `states` still NARROWS the fmcsa query below once one of these
    // FMCSA-specific keys enables it.
    const hasFmcsaFilter =
      (cfg.entityTypes?.length ?? 0) > 0 ||
      typeof cfg.minPowerUnits === "number" ||
      typeof cfg.maxPowerUnits === "number";
    if (!hasFmcsaFilter) {
      return { records: [], costUsd: 0, perSource: [] };
    }
    const params = new URLSearchParams();
    params.set("$limit", "200");
    params.set("$where", buildFmcsaWhere(cfg));
    params.set("$order", "add_date DESC");
    const url = `https://data.transportation.gov/resource/az4n-8mr2.json?${params.toString()}`;
    const tag = "data.transportation.gov/az4n-8mr2";

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      const message = `fetch failed: ${(err as Error).message ?? "network error"}`;
      return {
        records: [],
        costUsd: 0,
        perSource: [{ source: tag, label: "FMCSA Company Census", records: 0, error: message }],
      };
    }
    if (!res.ok) {
      const message = `returned ${res.status} ${res.statusText}`;
      return {
        records: [],
        costUsd: 0,
        perSource: [{ source: tag, label: "FMCSA Company Census", records: 0, error: message }],
      };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return {
        records: [],
        costUsd: 0,
        perSource: [
          {
            source: tag,
            label: "FMCSA Company Census",
            records: 0,
            error: "response was not valid JSON",
          },
        ],
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        records: [],
        costUsd: 0,
        perSource: [
          {
            source: tag,
            label: "FMCSA Company Census",
            records: 0,
            error: "response was not an array",
          },
        ],
      };
    }
    const records = mapFmcsaRows(parsed, cfg.sinceDays).slice(0, cfg.limit);
    if (records.length === 0) {
      const error = `${parsed.length} rows fetched, none within ${cfg.sinceDays}d window after filters`;
      return {
        records: [],
        costUsd: 0,
        perSource: [{ source: tag, label: "FMCSA Company Census", records: 0, error }],
      };
    }
    return {
      records,
      costUsd: 0,
      perSource: [{ source: tag, label: "FMCSA Company Census", records: records.length }],
    };
  },
};

// ---------------------------------------------------------------------------
// socrata-inspection — city health-inspection open-data portals
// ---------------------------------------------------------------------------

// Health-inspection schemas vary portal to portal like license schemas do;
// same common-field-name fallback strategy as SOCRATA_*_FIELDS above.
const INSPECTION_NAME_FIELDS = [
  "dba",
  "business_name",
  "establishment_name",
  "name",
  "facility_name",
];
const INSPECTION_ADDRESS_FIELDS = ["street", "business_address", "address", "address_line_1"];
const INSPECTION_CITY_FIELDS = ["city", "business_city"];
const INSPECTION_STATE_FIELDS = ["state", "business_state"];
const INSPECTION_PHONE_FIELDS = ["phone", "business_phone"];
const INSPECTION_DATE_FIELDS = ["inspection_date", "date", "activity_date"];

/**
 * Map + freshness-filter one portal's raw inspection rows. Exported for the
 * unit test's canned-payload check.
 *
 * DELIBERATELY drops every violation/score/grade field — `violation_code`,
 * `violation_description`, `critical_flag`, `score`, `grade`, `action` never
 * reach the mapped `RegistryRecord`, so no downstream caller (local-registry,
 * the priority adapter, the draft prompt) can ever see them. The card's copy
 * guardrail forbids the email citing a failed inspection or a score; the
 * cheapest way to enforce "never cites it" is "never carries it" — the
 * record only proves the establishment is currently operating + when it was
 * last inspected, never how it scored.
 */
export function mapInspectionRows(
  rows: unknown[],
  portalLabel: string,
  sinceDays: number,
): RegistryRecord[] {
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const seen = new Set<string>();
  const out: RegistryRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const name = pickField(rec, INSPECTION_NAME_FIELDS);
    if (!name) continue;
    const matchedDateIso = pickDateIso(rec, INSPECTION_DATE_FIELDS);
    if (!matchedDateIso) continue;
    if (Date.parse(matchedDateIso) < sinceMs) continue;
    const state = pickField(rec, INSPECTION_STATE_FIELDS);
    // Same establishment shows multiple rows (one per violation cited on an
    // inspection, or one per repeat inspection) — keep only the most recent
    // per (name, address, city, state) within this portal so the finder
    // sees one candidate per restaurant, not one per citation. name+state
    // alone collapsed distinct establishments that share a chain name in
    // the same state (e.g. two different "Subway" locations statewide) —
    // address+city narrow the key to one physical location.
    const dedupeKey = `${name.toLowerCase()}:${(pickField(rec, INSPECTION_ADDRESS_FIELDS) ?? "").toLowerCase()}:${(pickField(rec, INSPECTION_CITY_FIELDS) ?? "").toLowerCase()}:${(state ?? "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      name,
      address: pickField(rec, INSPECTION_ADDRESS_FIELDS),
      city: pickField(rec, INSPECTION_CITY_FIELDS),
      state,
      phone: pickField(rec, INSPECTION_PHONE_FIELDS),
      matchedDateIso,
      source: "socrata-inspection",
      sourceLabel: portalLabel,
    });
  }
  return out;
}

async function fetchInspectionPortal(
  portal: SocrataInspectionPortalConfig,
  cfg: RegistryQuery,
): Promise<{ records: RegistryRecord[]; diagnostic: string | null }> {
  const dateField = portal.dateField?.trim() || "inspection_date";
  const params = new URLSearchParams();
  params.set("$limit", "500");
  params.set("$order", `${dateField} DESC`);
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

  const records = mapInspectionRows(parsed, portal.label, cfg.sinceDays);
  if (records.length === 0) {
    return {
      records: [],
      diagnostic: `${portal.label}: ${parsed.length} rows fetched, none within ${cfg.sinceDays}d window`,
    };
  }
  return { records, diagnostic: null };
}

export const socrataInspectionSource: RegistrySource = {
  id: "socrata-inspection",
  async fetch(cfg) {
    const portals = cfg.inspectionPortals ?? [];
    const perSource: RegistryFetchOutcome["perSource"] = [];
    const records: RegistryRecord[] = [];
    for (const portal of portals) {
      if (records.length >= cfg.limit) break;
      const tag = `${portal.host}/${portal.dataset}`;
      try {
        const outcome = await fetchInspectionPortal(portal, cfg);
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
          { kind: "local-registry.inspection_portal", portal: portal.host, message_120: message },
          "warn",
        );
        perSource.push({ source: tag, label: portal.label, records: 0, error: message });
      }
    }
    return { records: records.slice(0, cfg.limit), costUsd: 0, perSource };
  },
};

export const REGISTRY_SOURCES: RegistrySource[] = [
  socrataLicenseSource,
  nppesSource,
  fmcsaSource,
  socrataInspectionSource,
];
