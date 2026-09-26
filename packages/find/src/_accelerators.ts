import type { StructuredSource } from "./_accelerator-structured.ts";
import type { CohortEntry } from "./accelerator-batch.ts";

/**
 * The accelerators the finder knows, and how their cohorts are named. Data,
 * not per-accelerator code: the cohort to search is computed from the date,
 * so a config that names accelerators instead of cohorts never goes stale.
 *
 * Cohort ids keep the forms earlier configs used (`yc-s26`, `antler-2026`),
 * so dedupe keys and queue history line up across the change.
 */

type Season = "winter" | "spring" | "summer" | "fall";
const SEASONS: Season[] = ["winter", "spring", "summer", "fall"];
const SEASON_LETTER: Record<Season, string> = { winter: "w", spring: "p", summer: "s", fall: "f" };

export interface Accelerator {
  id: string;
  name: string;
  /** `seasonal`: four batches a year (YC). `yearly`: one cohort id per year. */
  cadence: "seasonal" | "yearly";
  /** The accelerator's own company listing pages, read before any search hit. */
  listingUrls: string[];
  /** The name its cohorts are announced under, when it differs from `name` ("Neo Accelerator"). */
  programName?: string;
  /**
   * A listing that dates each company, read before any search (no LLM, no
   * paid read). `null`: checked, and nothing it publishes ties companies to a
   * year, so a run with no search hits says so instead of returning 0 silently.
   */
  structured?: StructuredSource | null;
}

export const ACCELERATORS: readonly Accelerator[] = [
  { id: "yc", name: "Y Combinator", cadence: "seasonal", listingUrls: [] },
  {
    id: "spc",
    name: "South Park Commons",
    programName: "South Park Commons Founder Fellowship",
    cadence: "yearly",
    listingUrls: ["https://www.southparkcommons.com/companies"],
    // Founding year, not a Founder Fellowship date: its companies are added to
    // search, never a substitute for it. The cohort label stays the neutral
    // "South Park Commons <year>".
    structured: {
      authoritative: false,
      kind: "json-script",
      url: "https://www.southparkcommons.com/companies",
      scriptId: "company-data",
      items: "",
      fields: { name: "name", year: "founded", oneLiner: "bio" },
    },
  },
  {
    id: "neo",
    name: "Neo",
    programName: "Neo Accelerator",
    cadence: "yearly",
    listingUrls: ["https://neo.com/companies"],
    // A Bubble app: the list renders client-side, with no public data API.
    structured: null,
  },
  {
    id: "antler",
    name: "Antler",
    cadence: "yearly",
    listingUrls: ["https://www.antler.co/portfolio"],
    // Investment year on every card; the list runs to ~35 pages, read in full.
    structured: {
      kind: "webflow-cms",
      url: "https://www.antler.co/portfolio",
      fields: { name: "name", year: "year", oneLiner: "description" },
    },
  },
  {
    id: "techstars",
    name: "Techstars",
    cadence: "yearly",
    listingUrls: ["https://www.techstars.com/portfolio"],
  },
  {
    id: "500-global",
    name: "500 Global",
    cadence: "yearly",
    listingUrls: ["https://500.co/companies"],
    // The portfolio table's own feed; the earliest investment date is the year.
    structured: {
      kind: "json-api",
      url: "https://500.co/api/startups",
      items: "res",
      fields: {
        name: "organization.businessName",
        year: "investments[].initialInvestDate",
        website: "organization.companyUrl",
        oneLiner: "oneLiner",
        founderFirst: "organization.positions[].person.firstName",
        founderLast: "organization.positions[].person.lastName",
      },
    },
  },
  {
    id: "ai-grant",
    name: "AI Grant",
    cadence: "yearly",
    listingUrls: ["https://aigrant.com"],
    // Lists companies by batch number only, with no dates.
    structured: null,
  },
  // Publishes batch facts (S25, W25), not a company list.
  { id: "hf0", name: "HF0", cadence: "yearly", listingUrls: [], structured: null },
  {
    id: "a16z-speedrun",
    name: "a16z speedrun",
    cadence: "yearly",
    listingUrls: ["https://speedrun.a16z.com/companies"],
    // The companies page's API. Cohorts are numbered: SR001 in 2023, then two
    // a year (SR006 Jan-Apr 2026, SR007 Jul-Oct 2026).
    structured: {
      kind: "json-api",
      url: "https://speedrun-api.a16z.com/api/companies/companies/?limit=96&offset=0&ordering=name",
      items: "results",
      next: "next",
      fields: {
        name: "name",
        year: { path: "cohort", pattern: "^SR0*(\\d+)$", firstYear: 2023, perYear: 2 },
        oneLiner: "preamble",
        id: "id",
      },
      detail: {
        url: "https://speedrun-api.a16z.com/api/companies/companies/{id}/",
        fields: {
          website: "website_url",
          founderFirst: "founder_set[].first_name",
          founderLast: "founder_set[].last_name",
          founderLinkedin: "founder_set[].linkedin_url",
        },
      },
    },
  },
];

export function getAccelerator(id: string): Accelerator | null {
  const key = id.trim().toLowerCase();
  return ACCELERATORS.find((a) => a.id === key) ?? null;
}

/**
 * The accelerator (and year, when the id names one) behind an explicit cohort
 * id such as `spc-2026-1` or `a16z-speedrun-2026`: the longest known id that
 * prefixes it. YC is left out; its ids route to yc-oss already.
 */
export function acceleratorOfCohortId(
  cohort: string,
): { accelerator: string; year?: number } | null {
  const id = cohort.trim().toLowerCase();
  const acc = ACCELERATORS.filter((a) => a.id !== "yc" && id.startsWith(`${a.id}-`)).toSorted(
    (a, b) => b.id.length - a.id.length,
  )[0];
  if (!acc) return null;
  const year = /(?:^|-)(20\d{2})(?:-|$)/.exec(id.slice(acc.id.length));
  return { accelerator: acc.id, ...(year ? { year: Number(year[1]) } : {}) };
}

/** A resolved cohort plus what the search adapter needs to target it. */
export interface ResolvedCohort extends CohortEntry {
  accelerator: string;
  /** The year the cohort belongs to — the extraction filter keys on it. */
  year: number;
  /** For yearly cohorts: the previous year's cohort, tried when this one yields nothing. */
  fallback?: CohortEntry & { year: number };
}

function seasonOf(date: Date): { season: Season; year: number } {
  return { season: SEASONS[Math.floor(date.getUTCMonth() / 3)]!, year: date.getUTCFullYear() };
}

function step(p: { season: Season; year: number }, by: number): { season: Season; year: number } {
  const i = SEASONS.indexOf(p.season) + by;
  const year = p.year + Math.floor(i / 4);
  return { season: SEASONS[((i % 4) + 4) % 4]!, year };
}

function ycCohort(p: { season: Season; year: number }): ResolvedCohort {
  const label = `YC ${p.season[0]!.toUpperCase()}${p.season.slice(1)} ${p.year}`;
  return {
    accelerator: "yc",
    cohort: `yc-${SEASON_LETTER[p.season]}${String(p.year).slice(2)}`,
    cohortLabel: label,
    year: p.year,
  };
}

/** `winter-2026` for yc-oss's batch files. */
export function ycSlugOf(cohort: ResolvedCohort): string {
  const letter = cohort.cohort.slice(3, 4);
  const season = (Object.keys(SEASON_LETTER) as Season[]).find((s) => SEASON_LETTER[s] === letter);
  return `${season}-${cohort.year}`;
}

/**
 * The `recent` most recent cohorts of an accelerator as of `now`.
 *
 * YC: walks back from the season after the current one (YC publishes a batch
 * as it starts) and keeps only batches yc-oss has published, via `ycBatchExists`,
 * so a batch not out yet is skipped. Yearly accelerators: the current year back
 * `recent` years, each with the year before as its fallback.
 */
export async function latestCohorts(
  acc: Accelerator,
  now: Date,
  recent: number,
  ycBatchExists: (slug: string) => Promise<boolean>,
): Promise<ResolvedCohort[]> {
  const n = Math.max(1, Math.floor(recent));
  if (acc.cadence === "seasonal") {
    const out: ResolvedCohort[] = [];
    let p = step(seasonOf(now), 1);
    for (let tries = 0; tries < n + 6 && out.length < n; tries++, p = step(p, -1)) {
      const c = ycCohort(p);
      if (await ycBatchExists(ycSlugOf(c))) out.push(c);
    }
    return out;
  }
  const year = now.getUTCFullYear();
  return Array.from({ length: n }, (_, i) => {
    const y = year - i;
    return {
      accelerator: acc.id,
      cohort: `${acc.id}-${y}`,
      cohortLabel: `${acc.name} ${y}`,
      year: y,
      fallback: { cohort: `${acc.id}-${y - 1}`, cohortLabel: `${acc.name} ${y - 1}`, year: y - 1 },
    };
  });
}

/** `accelerators` trigger config entry. */
export interface AcceleratorSelection {
  id: string;
  /** How many of its most recent cohorts to search. Default 1. */
  recent?: number;
}

/** Expand `accelerators` config into cohorts; unknown ids are skipped and reported. */
export async function resolveAcceleratorCohorts(
  selections: readonly AcceleratorSelection[],
  now: Date,
  ycBatchExists: (slug: string) => Promise<boolean>,
): Promise<{ cohorts: ResolvedCohort[]; unknown: string[] }> {
  const cohorts: ResolvedCohort[] = [];
  const unknown: string[] = [];
  for (const sel of selections) {
    const acc = getAccelerator(String(sel?.id ?? ""));
    if (!acc) {
      unknown.push(String(sel?.id ?? ""));
      continue;
    }
    cohorts.push(...(await latestCohorts(acc, now, sel.recent ?? 1, ycBatchExists)));
  }
  return { cohorts, unknown };
}
