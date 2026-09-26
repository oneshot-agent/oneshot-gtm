import { logEvent } from "@oneshot-gtm/core";

/**
 * Structured cohort sources: an accelerator's own listing that carries a
 * dated field per company (a founding year, an investment date, a numbered
 * cohort). Described as data in `_accelerators.ts` and read here by one
 * generic parser — plain HTTP, no LLM, no paid reads — so a listing that ties
 * companies to a year is filtered exactly instead of guessed at.
 */

/** A cohort field numbered in sequence ("SR007"): year = firstYear + floor(n / perYear). */
export interface NumberedCohortYear {
  path: string;
  /** Captures the cohort number, e.g. `^SR0*(\\d+)$`. */
  pattern: string;
  firstYear: number;
  perYear: number;
}

/**
 * Where each value lives in one listed item. Paths are dot paths; `[]` walks
 * every element of an array (`investments[].initialInvestDate`). The year is
 * the earliest four-digit year found at `year` — the date a company joined.
 */
export interface StructuredFields {
  name: string;
  year: string | NumberedCohortYear;
  website?: string;
  oneLiner?: string;
  founderFirst?: string;
  founderLast?: string;
  founderLinkedin?: string;
  /** Fills `{id}` in a detail URL. */
  id?: string;
}

interface StructuredBase {
  /**
   * Whether the listing's date IS the cohort (default true), so a loaded
   * listing decides the cohort alone. `false` when it dates something else
   * (a founding year): its companies are kept and search still runs.
   */
  authoritative?: boolean;
}

export type StructuredSource = StructuredBase &
  (
    | {
        /** JSON embedded in the page as `<script id="...">` (Next.js `__NEXT_DATA__`, Astro props). */
        kind: "json-script";
        url: string;
        scriptId: string;
        /** Path to the item array inside the JSON. */
        items: string;
        fields: StructuredFields;
      }
    | {
        /** A public JSON endpoint the listing page itself calls. */
        kind: "json-api";
        url: string;
        items: string;
        /** Path to the next page's URL, for a paginated endpoint. */
        next?: string;
        fields: StructuredFields;
        /** Per-company endpoint (`{id}`) for fields the list omits; read only for kept companies. */
        detail?: { url: string; fields: Omit<StructuredFields, "name" | "year"> };
      }
    | {
        /**
         * A Webflow CMS list with Finsweet filter attributes
         * (`fs-cmsfilter-field="name"`), paginated by `?<list>_page=N`.
         * `fields` names the attribute values; the website is the card's
         * first external link.
         */
        kind: "webflow-cms";
        url: string;
        fields: { name: string; year: string; oneLiner?: string };
      }
  );

/** A listed company, normalised across source kinds. */
export interface StructuredItem {
  name: string;
  year: number | null;
  website: string | null;
  oneLiner: string | null;
  founderName: string | null;
  founderLinkedinUrl: string | null;
  id: string | null;
}

/** Pages fetched per source (JSON pages or Webflow list pages). Free, but bounded. */
export const MAX_STRUCTURED_PAGES = 50;
const DETAIL_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 15 * 60_000;
const UA = "Mozilla/5.0 (compatible; oneshot-gtm accelerator-batch)";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, { at: number; items: StructuredItem[] }>();

/** Test hook. */
export function _resetStructuredCache(): void {
  cache.clear();
}

/** Every value at a dot path; `[]` fans out over an array. */
export function valuesAt(root: unknown, path: string): unknown[] {
  let cur: unknown[] = [root];
  for (const part of path.split(".")) {
    const fan = part.endsWith("[]");
    const key = fan ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const v of cur) {
      if (!v || typeof v !== "object") continue;
      const got = key ? (v as Record<string, unknown>)[key] : v;
      if (fan) {
        if (Array.isArray(got)) next.push(...got);
      } else if (got !== undefined && got !== null) next.push(got);
    }
    cur = next;
  }
  return cur;
}

function firstString(root: unknown, path: string | undefined): string | null {
  if (!path) return null;
  for (const v of valuesAt(root, path)) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function yearOf(root: unknown, spec: string | NumberedCohortYear): number | null {
  if (typeof spec !== "string") {
    const raw = firstString(root, spec.path);
    const m = raw ? new RegExp(spec.pattern).exec(raw) : null;
    if (!m?.[1]) return null;
    return spec.firstYear + Math.floor(Number(m[1]) / spec.perYear);
  }
  let min: number | null = null;
  for (const v of valuesAt(root, spec)) {
    const m = /\b((?:19|20)\d{2})\b/.exec(String(v));
    if (m) min = min === null ? Number(m[1]) : Math.min(min, Number(m[1]));
  }
  return min;
}

function httpUrl(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function itemFrom(root: unknown, f: StructuredFields): StructuredItem | null {
  const name = firstString(root, f.name);
  if (!name) return null;
  const first = firstString(root, f.founderFirst);
  const last = firstString(root, f.founderLast);
  return {
    name,
    year: yearOf(root, f.year),
    website: httpUrl(firstString(root, f.website)),
    oneLiner: firstString(root, f.oneLiner),
    founderName: [first, last].filter(Boolean).join(" ") || null,
    founderLinkedinUrl: firstString(root, f.founderLinkedin),
    id: firstString(root, f.id),
  };
}

async function get(fetchImpl: Fetch, url: string): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { "user-agent": UA, accept: "text/html,application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** The body of `<script id="...">`, found by index scan (no backtracking regex). */
export function scriptBody(html: string, id: string): string | null {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf("<script", at);
  const start = html.indexOf(">", at);
  const end = html.indexOf("</script>", start);
  if (open < 0 || start < 0 || end < 0) return null;
  return html.slice(start + 1, end);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Items of one Webflow CMS list page, plus the next page's URL. */
export function parseWebflowPage(
  html: string,
  pageUrl: string,
  fields: { name: string; year: string; oneLiner?: string },
): { items: StructuredItem[]; next: string | null } {
  const ownHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const items: StructuredItem[] = [];
  for (const chunk of html.split('role="listitem"').slice(1)) {
    const text = (field: string): string | null => {
      const at = chunk.indexOf(`fs-cmsfilter-field="${field}"`);
      if (at < 0) return null;
      // The value is the first text node after the attribute (nested tags allowed).
      const m = /^[^>]*>(?:\s*<[^>]{0,400}>){0,3}([^<]{1,300})</.exec(chunk.slice(at));
      return m?.[1] ? decodeEntities(m[1]) : null;
    };
    const name = text(fields.name);
    if (!name) continue; // a filter checkbox, not a company card
    const yearText = text(fields.year);
    const y = yearText ? /\b((?:19|20)\d{2})\b/.exec(yearText) : null;
    let website: string | null = null;
    for (const m of chunk.matchAll(/href="(https?:\/\/[^"]{1,300})"/g)) {
      try {
        if (new URL(m[1]!).hostname.replace(/^www\./, "") !== ownHost) {
          website = m[1]!;
          break;
        }
      } catch {
        // malformed href; keep looking
      }
    }
    items.push({
      name,
      year: y ? Number(y[1]) : null,
      website,
      oneLiner: fields.oneLiner ? text(fields.oneLiner) : null,
      founderName: null,
      founderLinkedinUrl: null,
      id: null,
    });
  }
  const current = Number(/[?&]([a-z0-9]+)_page=(\d+)/i.exec(pageUrl)?.[2] ?? "1");
  const nextM = new RegExp(`href="\\?([a-z0-9]+_page)=${current + 1}"`, "i").exec(html);
  const next = nextM ? `${pageUrl.split("?")[0]}?${nextM[1]}=${current + 1}` : null;
  return { items, next };
}

async function loadItems(source: StructuredSource, fetchImpl: Fetch): Promise<StructuredItem[]> {
  if (source.kind === "json-script") {
    const body = scriptBody(await get(fetchImpl, source.url), source.scriptId);
    if (body === null) throw new Error(`no <script id="${source.scriptId}"> on ${source.url}`);
    const list = valuesAt(JSON.parse(body), source.items)[0];
    if (!Array.isArray(list)) throw new Error(`no item array at '${source.items}'`);
    return list.map((x) => itemFrom(x, source.fields)).filter((x) => x !== null);
  }
  if (source.kind === "json-api") {
    const out: StructuredItem[] = [];
    let url: string | null = source.url;
    for (let page = 0; url && page < MAX_STRUCTURED_PAGES; page++) {
      const json: unknown = JSON.parse(await get(fetchImpl, url));
      const list = valuesAt(json, source.items)[0];
      if (!Array.isArray(list)) throw new Error(`no item array at '${source.items}'`);
      for (const x of list) {
        const item = itemFrom(x, source.fields);
        if (item) out.push(item);
      }
      url = source.next ? firstString(json, source.next) : null;
    }
    return out;
  }
  const out: StructuredItem[] = [];
  let url: string | null = source.url;
  for (let page = 0; url && page < MAX_STRUCTURED_PAGES; page++) {
    const parsed = parseWebflowPage(await get(fetchImpl, url), url, source.fields);
    out.push(...parsed.items);
    url = parsed.next;
  }
  return out;
}

async function fillDetails(
  items: StructuredItem[],
  detail: NonNullable<Extract<StructuredSource, { kind: "json-api" }>["detail"]>,
  fetchImpl: Fetch,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      if (!item.id) continue;
      try {
        const json: unknown = JSON.parse(
          await get(fetchImpl, detail.url.replace("{id}", encodeURIComponent(item.id))),
        );
        const d = itemFrom(
          { ...(json as object), __name: item.name },
          {
            ...detail.fields,
            name: "__name",
            year: "__none",
          },
        );
        if (!d) continue;
        item.website ??= d.website;
        item.oneLiner ??= d.oneLiner;
        item.founderName ??= d.founderName;
        item.founderLinkedinUrl ??= d.founderLinkedinUrl;
      } catch (err) {
        logEvent(
          "error.swallowed",
          {
            kind: "accelerator-structured.detail",
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
      }
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
}

/**
 * The companies a structured source lists for `year`, capped at `max`.
 * `listed` is how many companies the source lists in all, for the diagnostic.
 * Throws when the source cannot be read or has changed shape, so the caller
 * can fall back to search.
 */
export async function fetchStructuredCohort(
  source: StructuredSource,
  year: number,
  max: number,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<{ items: StructuredItem[]; listed: number }> {
  const key = JSON.stringify(source);
  const hit = cache.get(key);
  let all: StructuredItem[];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) all = hit.items;
  else {
    all = await loadItems(source, fetchImpl);
    if (all.length === 0) throw new Error(`no companies parsed from ${source.url}`);
    // Names but no dates: the year field moved. Not cached, so the next run retries.
    if (all.every((i) => i.year === null)) {
      throw new Error(`no dated companies parsed from ${source.url}`);
    }
    cache.set(key, { at: Date.now(), items: all });
  }
  const seen = new Set<string>();
  const items: StructuredItem[] = [];
  for (const item of all) {
    if (item.year !== year) continue;
    const k = item.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ ...item });
    if (items.length >= max) break;
  }
  if (source.kind === "json-api" && source.detail) {
    await fillDetails(items, source.detail, fetchImpl);
  }
  return { items, listed: all.length };
}
