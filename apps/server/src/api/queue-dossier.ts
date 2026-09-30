import {
  getCachedNewsfeed,
  getLedger,
  type NewsfeedPost,
  newsfeedPostsFrom,
} from "@oneshot-gtm/core";
import { organizationsFromResearch, personCacheKey } from "@oneshot-gtm/find";
import type {
  DossierEducationView,
  DossierPostView,
  DossierRoleView,
  QueueDossierView,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

type JsonRecord = Record<string, unknown>;

function record(v: unknown): JsonRecord | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The full cached `deepResearchPerson` result for this row, looked up by the
 * same keys research writes under. Read past the purchase TTL: this is for
 * display, and a stale dossier with its date beats none.
 */
function cachedResearch(
  candidates: { url: string | null; email: string | null }[],
): { result: JsonRecord; fetchedAt: string } | null {
  const ledger = getLedger();
  const keys = new Set<string>();
  for (const c of candidates) {
    for (const input of [{ socialMediaUrl: c.url ?? undefined }, { email: c.email ?? undefined }]) {
      const key = personCacheKey(input);
      if (key) keys.add(key);
    }
  }
  for (const key of keys) {
    let cached: ReturnType<typeof ledger.getCachedEnrichment> = null;
    try {
      cached = ledger.getCachedEnrichment(key);
    } catch {
      continue;
    }
    if (!cached || cached.status === "failed") continue;
    try {
      const parsed = record(JSON.parse(cached.result_json));
      const result = record(parsed?.["result"]);
      if (result) return { result, fetchedAt: new Date(cached.fetched_at).toISOString() };
    } catch {
      // unreadable entry: try the next key
    }
  }
  return null;
}

function postView(p: NewsfeedPost, source: DossierPostView["source"]): DossierPostView {
  return {
    platform: p.platform ?? null,
    content: p.content ?? null,
    url: p.url ?? null,
    postedAt: p.postedAt ?? null,
    likes: p.likes ?? null,
    replies: p.replies ?? null,
    shares: p.shares ?? null,
    isRepost: p.isRepost,
    source,
  };
}

function postTime(p: DossierPostView): number {
  const t = p.postedAt ? Date.parse(p.postedAt) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Both post sources, deduped by url (else by text), newest first; undated posts last. */
export function mergePosts(research: NewsfeedPost[], newsfeed: NewsfeedPost[]): DossierPostView[] {
  const seen = new Set<string>();
  const out: DossierPostView[] = [];
  const add = (p: NewsfeedPost, source: DossierPostView["source"]): void => {
    const key = p.url?.trim().toLowerCase() || `text:${(p.content ?? "").trim().slice(0, 200)}`;
    if (key === "text:" || seen.has(key)) return;
    seen.add(key);
    out.push(postView(p, source));
  };
  for (const p of newsfeed) add(p, "newsfeed");
  for (const p of research) add(p, "research");
  return out.toSorted((a, b) => postTime(b) - postTime(a));
}

function educationFrom(result: JsonRecord): DossierEducationView[] {
  const scopes = [result, record(result["enrichment"])].filter((s): s is JsonRecord => s != null);
  const out: DossierEducationView[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const raw of Array.isArray(scope["education"]) ? scope["education"] : []) {
      const r = record(raw);
      const school = str(r?.["school"]) ?? str(r?.["name"]);
      if (!r || !school) continue;
      const degree = str(r["degree"]);
      const id = `${school.toLowerCase()}|${degree ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ school, degree, period: str(r["period"]) });
    }
  }
  return out;
}

function experienceFrom(orgs: ReturnType<typeof organizationsFromResearch>): DossierRoleView[] {
  const views = orgs.map((o) => ({
    company: o.name,
    title: o.title ?? null,
    startDate: o.startDate ?? null,
    endDate: o.endDate ?? null,
    current: o.current,
  }));
  return [...views.filter((v) => v.current), ...views.filter((v) => !v.current)];
}

/** The full dossier behind a queue row. Read-only: never buys research or a newsfeed. */
export function buildQueueDossier(payload: unknown): QueueDossierView {
  const p = record(payload) ?? {};
  const summary = record(p["personResearch"]);
  const seed = record(summary?.["seed"]);
  const candidates = [
    { url: str(seed?.["url"]), email: str(seed?.["email"]) },
    { url: str(p["linkedinUrl"]) ?? str(summary?.["linkedinUrl"]), email: str(p["email"]) },
  ];
  const full = cachedResearch(candidates);
  const result = full?.result ?? null;
  const inner = record(result?.["enrichment"]);
  const pick = (key: string): string | null => str(result?.[key]) ?? str(inner?.[key]);

  const fromResearch = result ? organizationsFromResearch(result) : [];
  // No full research: the row's bounded summary already holds the history (≤8).
  const summaryOrgs = (Array.isArray(summary?.["organizations"]) ? summary["organizations"] : [])
    .map(record)
    .flatMap((o) => {
      const name = str(o?.["name"]);
      return o && name
        ? [
            {
              name,
              ...(str(o["title"]) ? { title: str(o["title"])! } : {}),
              ...(str(o["startDate"]) ? { startDate: str(o["startDate"])! } : {}),
              ...(str(o["endDate"]) ? { endDate: str(o["endDate"])! } : {}),
              current: o["current"] === true,
            },
          ]
        : [];
    });
  const experience = experienceFrom(fromResearch.length > 0 ? fromResearch : summaryOrgs);

  const company = record(summary?.["company"]);
  const newsfeedUrl = str(record(summary?.["newsfeed"])?.["url"]);
  const captured = newsfeedUrl ? getCachedNewsfeed(newsfeedUrl, getLedger()) : null;
  const researchPosts = result ? newsfeedPostsFrom({ result: result["recent_posts"] }) : [];

  return {
    status: full ? "complete" : summary ? "summary-only" : "none",
    researchedAt: full?.fetchedAt ?? str(summary?.["researchedAt"]),
    person: {
      fullName: pick("full_name"),
      title: pick("title") ?? str(record(summary?.["currentRole"])?.["title"]),
      company: pick("company") ?? str(record(summary?.["currentRole"])?.["company"]),
      location: pick("location") ?? str(summary?.["location"]),
      summary: pick("summary") ?? str(summary?.["bio"]),
      linkedinUrl: pick("linkedin_url") ?? str(summary?.["linkedinUrl"]),
      emails: strings([
        ...strings(result?.["emails"]),
        ...strings(result?.["altemails"]),
        str(result?.["best_work_email"]),
        str(summary?.["workEmail"]),
      ]),
      phones: strings([...strings(result?.["phones"]), ...strings(result?.["fullphone"])]),
      skills: strings(result?.["skills"] ?? inner?.["skills"]),
    },
    experience,
    education: result ? educationFrom(result) : [],
    company: company
      ? {
          name: str(company["name"]),
          domain: str(company["domain"]),
          industry: str(company["industry"]),
          location: str(company["location"]),
          size: str(company["size"]),
          fundingStage: str(company["fundingStage"]),
          description: str(company["description"]),
        }
      : null,
    posts: mergePosts(researchPosts, captured?.posts ?? []),
    newsfeedFetchedAt: captured?.fetchedAt ?? null,
  };
}

export function queueDossierRoute(req: Request, params: Record<string, string>): Response {
  const id = Number(params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "bad id" }, 400, req);
  const row = getLedger().getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    // an unreadable payload has no dossier
  }
  return jsonResponse(buildQueueDossier(payload), 200, req);
}
