import type {
  DecidedByFilter,
  ProspectBrowseRow,
  ProspectSearchResponse,
  ProspectSortKey,
  QueueCounts,
  QueueStatusView,
} from "@oneshot-gtm/shared-types";
import { companyFor, emailFor, nameFor, titleFor } from "./payloadIdentity.ts";

/**
 * /prospects keeps its filters in the URL so a search is a link. Defaults are
 * left OUT of the URL (`parseProspectsSearch` drops them, `toApiQuery` omits
 * them) — `/prospects` stays clean and the demo's fixture path stays stable.
 */
export interface ProspectsSearch {
  q?: string;
  status?: QueueStatusView;
  play?: string;
  decided?: DecidedByFilter;
  sort?: ProspectSortKey;
  dir?: "asc" | "desc";
  /** 1-based. Absent = first page. */
  page?: number;
}

export const PAGE_SIZE = 50;

/**
 * Mirrors the server's name expression: a real name (prospect record, then
 * `name`/`founderName`) counts; a handle derived from a URL does not, so
 * URL-only rejects sort after every named row in both directions.
 */
function displayName(r: ProspectBrowseRow): string | null {
  const p =
    r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : null;
  // `||`, not `??`: SQL's NULLIF(…, '') treats an empty name as missing too.
  const raw = r.prospect?.name || p?.["name"] || p?.["founderName"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function payloadText(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

const STATUSES = new Set<QueueStatusView>(["pending", "approved", "rejected", "sent", "expired"]);
const DECIDED = new Set<DecidedByFilter>(["human", "machine", "none"]);
const SORTS = new Set<ProspectSortKey>(["found", "decided", "name"]);

/** For `validateSearch`: keep only well-formed, non-default values. */
export function parseProspectsSearch(raw: Record<string, unknown>): ProspectsSearch {
  const out: ProspectsSearch = {};
  const q = typeof raw["q"] === "string" ? raw["q"].trim() : "";
  if (q) out.q = q;
  if (typeof raw["status"] === "string" && STATUSES.has(raw["status"] as QueueStatusView)) {
    out.status = raw["status"] as QueueStatusView;
  }
  if (typeof raw["play"] === "string" && raw["play"].trim()) out.play = raw["play"].trim();
  if (typeof raw["decided"] === "string" && DECIDED.has(raw["decided"] as DecidedByFilter)) {
    out.decided = raw["decided"] as DecidedByFilter;
  }
  if (typeof raw["sort"] === "string" && SORTS.has(raw["sort"] as ProspectSortKey)) {
    out.sort = raw["sort"] as ProspectSortKey;
  }
  if (raw["dir"] === "asc") out.dir = "asc";
  const page =
    typeof raw["page"] === "number"
      ? raw["page"]
      : typeof raw["page"] === "string" && /^\d+$/.test(raw["page"])
        ? Number.parseInt(raw["page"], 10)
        : 1;
  if (Number.isFinite(page) && page > 1) out.page = Math.floor(page);
  return out;
}

/** The `/queue/search?…` query string for a search — sorted keys, defaults omitted. */
export function toApiQuery(s: ProspectsSearch): string {
  const q = new URLSearchParams();
  if (s.decided) q.set("decided", s.decided);
  if (s.dir === "asc") q.set("dir", "asc");
  q.set("limit", String(PAGE_SIZE));
  const offset = ((s.page ?? 1) - 1) * PAGE_SIZE;
  if (offset > 0) q.set("offset", String(offset));
  if (s.play) q.set("play", s.play);
  if (s.q) q.set("q", s.q);
  if (s.sort) q.set("sort", s.sort);
  if (s.status) q.set("status", s.status);
  return q.toString();
}

export interface PageSummary {
  /** 1-based index of the first row shown; 0 when the page is empty. */
  from: number;
  to: number;
  page: number;
  pages: number;
}

export function pageSummary(total: number, offset: number, limit: number): PageSummary {
  const size = Math.max(1, limit);
  const pages = Math.max(1, Math.ceil(total / size));
  if (total === 0) return { from: 0, to: 0, page: 1, pages: 1 };
  // An offset past the end (rows approved out from under a deep page) reads
  // as the last page, never as "showing 101–95".
  const page = Math.min(pages, Math.floor(offset / size) + 1);
  const start = (page - 1) * size;
  return { from: start + 1, to: Math.min(total, start + size), page, pages };
}

/** True when the requested page starts past the last row (and there are rows). */
export function pastEnd(total: number, offset: number): boolean {
  return total > 0 && offset >= total;
}

/**
 * Demo mode serves one captured `/queue/search?limit=500` document (the whole
 * seeded ledger) and runs the search here, so the box works without an
 * unbounded fixture space. Same semantics as `Ledger.searchQueue`: terms
 * AND-ed as case-insensitive substrings over the identity keys, notes, play
 * and the linked prospect; the same three sorts; the same paging.
 */
export function applyProspectFilters(
  rows: ReadonlyArray<ProspectBrowseRow>,
  s: ProspectsSearch,
): ProspectSearchResponse {
  const terms = (s.q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // The same fields `Ledger.searchQueue` concatenates, in JS.
  const haystack = (r: ProspectBrowseRow): string =>
    [
      nameFor(r.payload),
      emailFor(r.payload),
      companyFor(r.payload),
      titleFor(r.payload),
      payloadText(r.payload, "postTitle"),
      payloadText(r.payload, "repoUrl"),
      payloadText(r.payload, "postUrl"),
      payloadText(r.payload, "linkedinUrl"),
      r.notes,
      r.playName,
      r.prospect?.name,
      r.prospect?.email,
      r.prospect?.company,
      r.prospect?.title,
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ")
      .toLowerCase();
  const unpaged = rows.filter((r) => {
    if (s.play && r.playName !== s.play) return false;
    if (s.decided === "human" && !(r.decidedBy === "human" || r.decidedBy === "human_bulk"))
      return false;
    if (s.decided === "machine" && r.decidedBy !== "machine") return false;
    if (s.decided === "none" && r.decidedBy != null) return false;
    if (terms.length > 0) {
      const h = haystack(r);
      if (!terms.every((t) => h.includes(t))) return false;
    }
    return true;
  });
  const counts: QueueCounts = { pending: 0, approved: 0, rejected: 0, sent: 0, expired: 0 };
  for (const r of unpaged) counts[r.status] += 1;
  const matched = s.status ? unpaged.filter((r) => r.status === s.status) : unpaged;

  const dir = s.dir === "asc" ? 1 : -1;
  const cmp = (a: ProspectBrowseRow, b: ProspectBrowseRow): number => {
    if (s.sort === "decided") {
      if (a.decidedAt == null || b.decidedAt == null) {
        return a.decidedAt == null && b.decidedAt == null ? 0 : a.decidedAt == null ? 1 : -1;
      }
      return a.decidedAt === b.decidedAt ? 0 : (a.decidedAt < b.decidedAt ? -1 : 1) * dir;
    }
    if (s.sort === "name") {
      const an = displayName(a);
      const bn = displayName(b);
      if (an == null || bn == null) {
        if (an != null || bn != null) return an == null ? 1 : -1;
        // Both URL-only: order by the derived handle, as the server does.
        return (
          (nameFor(a.payload) ?? a.dedupeKey)
            .toLowerCase()
            .localeCompare((nameFor(b.payload) ?? b.dedupeKey).toLowerCase()) * dir
        );
      }
      return an.toLowerCase().localeCompare(bn.toLowerCase()) * dir;
    }
    return a.foundAt === b.foundAt ? 0 : (a.foundAt < b.foundAt ? -1 : 1) * dir;
  };
  const sorted = matched.toSorted((a, b) => cmp(a, b) || (a.id - b.id) * dir);
  const offset = ((s.page ?? 1) - 1) * PAGE_SIZE;
  return {
    rows: sorted.slice(offset, offset + PAGE_SIZE),
    total: sorted.length,
    limit: PAGE_SIZE,
    offset,
    counts,
    plays: [...new Set(rows.map((r) => r.playName))].toSorted(),
  };
}
