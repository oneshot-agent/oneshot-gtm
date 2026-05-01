import type { CompanyRecord } from "./_types.ts";

/**
 * Adapter for the [yc-oss/api](https://github.com/yc-oss/api) public dataset.
 * Free, daily-updated, no auth — strictly better than scraping YC's
 * client-rendered launches page.
 *
 * Schema reference (from `https://yc-oss.github.io/api/batches/<slug>.json`):
 * each record has `name, slug, website, one_liner, long_description, industry,
 * subindustry, tags, batch, status, url, api`. No founder names — the
 * downstream pipeline still calls findEmail on the company domain.
 */

const YC_OSS_BASE = "https://yc-oss.github.io/api/batches";

/**
 * Map a cohort tag (`yc-w26`, `yc-s25`, `yc-spring-26`, `yc-fall-25`) to the
 * yc-oss batch slug (`winter-2026`, `summer-2025`, `spring-2026`, `fall-2025`).
 *
 * Pass-through behavior: a tag that already looks like an yc-oss slug
 * (`winter-2026`, `summer-2024`, etc.) is returned unchanged so founders can
 * paste either form into config.
 *
 * Returns null when the tag doesn't match any known pattern — caller should
 * surface this as a diagnostic, not throw, so the trigger card shows the
 * real reason instead of a 500.
 */
export function cohortToBatchSlug(tag: string): string | null {
  const normalized = tag.trim().toLowerCase();
  if (normalized.length === 0) return null;

  // Already a yc-oss slug? Accept it verbatim.
  if (/^(winter|summer|spring|fall)-\d{4}$/.test(normalized)) {
    return normalized;
  }

  // yc-w26 / yc-s25 — single-letter season + 2-digit year.
  const short = normalized.match(/^yc-([wsfp])(\d{2})$/);
  if (short) {
    const letter = short[1] as "w" | "s" | "f" | "p";
    const yy = short[2] as string;
    const season = SHORT_SEASON[letter];
    if (!season) return null;
    return `${season}-20${yy}`;
  }

  // yc-spring-26 / yc-fall-25 — full season name + 2-digit year.
  const long = normalized.match(/^yc-(winter|summer|spring|fall)-(\d{2})$/);
  if (long) {
    return `${long[1]}-20${long[2]}`;
  }

  // yc-w-2026 / yc-winter-2026 — 4-digit year variants.
  const fourYear = normalized.match(/^yc-(winter|summer|spring|fall|[wsfp])-(\d{4})$/);
  if (fourYear) {
    const seasonRaw = fourYear[1] as string;
    const yyyy = fourYear[2] as string;
    const season =
      seasonRaw.length === 1
        ? SHORT_SEASON[seasonRaw as "w" | "s" | "f" | "p"]
        : (seasonRaw as "winter" | "summer" | "spring" | "fall");
    if (!season) return null;
    return `${season}-${yyyy}`;
  }

  return null;
}

const SHORT_SEASON: Record<"w" | "s" | "f" | "p", "winter" | "summer" | "fall" | "spring"> = {
  w: "winter",
  s: "summer",
  f: "fall",
  p: "spring", // "p" for sPring — yc convention varies; spring is rare so this is a best-guess fallback
};

/**
 * Build a human-readable cohort label from a cohort tag, used when the
 * founder didn't supply `cohortLabel` explicitly.
 *
 * - `yc-w26` → `YC W26` (preserves the canonical YC short form for emails)
 * - `yc-winter-2026` → `YC Winter 2026`
 * - `techstars-toronto-2025` → `Techstars Toronto 2025` (Title-Case + spaces)
 *
 * Used by the websearch adapter's query builder, so a wrong default would
 * search for the wrong program. Tightens behavior after a `cohort` edit —
 * the previous hardcoded `"YC W26"` default would silently mismatch.
 */
export function deriveCohortLabel(cohort: string): string {
  const tag = cohort.trim();
  if (tag.length === 0) return "";
  // Special-case YC short tags to keep the canonical "YC W26" form.
  const ycShort = tag.match(/^yc-([wsfp])(\d{2})$/i);
  if (ycShort) {
    const letter = ycShort[1]!.toUpperCase();
    const yy = ycShort[2]!;
    return `YC ${letter}${yy}`;
  }
  // Generic: split on hyphens, title-case each part. "yc" stays uppercase
  // when it's the first segment.
  return tag
    .split("-")
    .map((part, i) => {
      if (i === 0 && part.toLowerCase() === "yc") return "YC";
      if (/^\d+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

interface YcOssCompany {
  name?: unknown;
  website?: unknown;
  one_liner?: unknown;
  long_description?: unknown;
  industry?: unknown;
  tags?: unknown;
  url?: unknown;
}

/**
 * Fetch a yc-oss batch and map records to the normalized `CompanyRecord`
 * shape. Honors `limit` so we don't pull a 200-record batch when the founder
 * only wants 25.
 *
 * Returns:
 * - `records`: zero or more company records.
 * - `diagnostic`: human-readable reason when records is empty (404, parse
 *   error, unknown tag) so the UI can surface it instead of treating zero
 *   as success.
 *
 * Cost is always 0 — yc-oss is GitHub Pages, no LLM, no auth.
 */
export async function fetchYcOssBatch(
  cohort: string,
  limit: number,
): Promise<{ records: CompanyRecord[]; costUsd: number; diagnostic: string | null }> {
  const slug = cohortToBatchSlug(cohort);
  if (!slug) {
    return {
      records: [],
      costUsd: 0,
      diagnostic: `unknown YC cohort tag '${cohort}' — try 'yc-w26', 'yc-s25', or 'winter-2026'`,
    };
  }
  const url = `${YC_OSS_BASE}/${slug}.json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      records: [],
      costUsd: 0,
      diagnostic: `yc-oss fetch failed: ${(err as Error).message ?? "network error"}`,
    };
  }
  if (!res.ok) {
    if (res.status === 404) {
      return {
        records: [],
        costUsd: 0,
        diagnostic: `yc-oss has no batch '${slug}' yet — likely too new or misspelled cohort`,
      };
    }
    return {
      records: [],
      costUsd: 0,
      diagnostic: `yc-oss returned ${res.status} ${res.statusText}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { records: [], costUsd: 0, diagnostic: "yc-oss response was not valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], costUsd: 0, diagnostic: "yc-oss response was not an array" };
  }
  if (parsed.length === 0) {
    return {
      records: [],
      costUsd: 0,
      diagnostic: `yc-oss has no companies for batch '${slug}' yet — likely too new`,
    };
  }
  const records = parsed
    .slice(0, limit)
    .map((c) => mapYcOssCompany(c as YcOssCompany))
    .filter((r): r is CompanyRecord => r !== null);
  if (records.length === 0) {
    return {
      records: [],
      costUsd: 0,
      diagnostic: `yc-oss returned ${parsed.length} records but none had a usable name`,
    };
  }
  return { records, costUsd: 0, diagnostic: null };
}

/** Map a single yc-oss company JSON object to the normalized shape. Returns null for malformed records. */
export function mapYcOssCompany(c: YcOssCompany): CompanyRecord | null {
  const name = typeof c.name === "string" ? c.name.trim() : "";
  if (name.length === 0) return null;
  return {
    name,
    website: typeof c.website === "string" && c.website.length > 0 ? c.website : null,
    oneLiner: typeof c.one_liner === "string" && c.one_liner.length > 0 ? c.one_liner : null,
    longDescription:
      typeof c.long_description === "string" && c.long_description.length > 0
        ? c.long_description
        : null,
    industry: typeof c.industry === "string" && c.industry.length > 0 ? c.industry : null,
    tags: Array.isArray(c.tags) ? (c.tags.filter((t) => typeof t === "string") as string[]) : [],
    ycUrl: typeof c.url === "string" && c.url.length > 0 ? c.url : null,
    // yc-oss schema doesn't include founder names — pipeline resolves them on
    // demand via webRead+extract on the YC profile URL.
    founderName: null,
    founderLinkedinUrl: null,
    founderPhone: null,
    source: "yc-oss",
  };
}
