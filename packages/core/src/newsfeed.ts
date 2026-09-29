import { getLedger } from "./ledger.ts";
import { canonicalLinkedInProfileKey } from "./ledger-prospects.ts";
import { NEWSFEED_CACHE_TTL_MS } from "./ledger-cache.ts";

/**
 * The read side of a person's captured newsfeed: which profile a feed is
 * keyed by, how a cached capture parses into posts, and the lookup itself.
 * Buying a feed lives in find (`_newsfeed.ts`); reading one lives here so a
 * play can draft from posts without depending on the finders.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// X paths that are pages, not profiles.
const X_RESERVED = new Set([
  "home",
  "i",
  "intent",
  "search",
  "share",
  "explore",
  "hashtag",
  "settings",
  "messages",
  "notifications",
  "login",
  "signup",
]);

/** A canonical X profile URL (`https://x.com/<handle>`), or null for anything else. */
export function canonicalXProfileUrl(value: string): string | null {
  try {
    const url = new URL(value.trim().startsWith("http") ? value.trim() : `https://${value.trim()}`);
    const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
    if (host !== "x.com" && host !== "twitter.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    const handle = parts[0]!.replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || X_RESERVED.has(handle)) return null;
    return `https://x.com/${handle}`;
  } catch {
    return null;
  }
}

/** A canonical LinkedIn profile URL (`https://www.linkedin.com/in/<slug>`), or null. */
function canonicalLinkedInUrl(value: string): string | null {
  const key = canonicalLinkedInProfileKey(
    value.trim().startsWith("http") ? value.trim() : `https://${value.trim()}`,
  );
  if (!key) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(key.slice("linkedin.com/in/".length))}`;
}

/**
 * The profile to capture a newsfeed from: the first LinkedIn `/in/` URL among
 * the candidates, else the first X profile URL. Nothing else — a GitHub or
 * event page has no feed.
 */
export function newsfeedSeedUrl(candidates: ReadonlyArray<unknown>): string | null {
  const strings = candidates.filter((c): c is string => typeof c === "string" && c.trim() !== "");
  for (const c of strings) {
    const li = canonicalLinkedInUrl(c);
    if (li) return li;
  }
  for (const c of strings) {
    const x = canonicalXProfileUrl(c);
    if (x) return x;
  }
  return null;
}

export function newsfeedCacheKey(url: string): string {
  return `newsfeed:${url.toLowerCase()}`;
}

export interface NewsfeedPost {
  platform?: string;
  content?: string;
  url?: string;
  postedAt?: string;
  likes?: number;
  replies?: number;
  shares?: number;
  /** A repost of someone else's post ("RT @handle: …"): the words are not theirs. */
  isRepost: boolean;
}

export interface CapturedNewsfeed {
  url: string;
  fetchedAt: string;
  posts: NewsfeedPost[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Posts from a raw personNewsfeed result; reposts are marked, not dropped. */
export function newsfeedPostsFrom(result: unknown): NewsfeedPost[] {
  const list = isRecord(result) && Array.isArray(result["result"]) ? result["result"] : [];
  const out: NewsfeedPost[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const content = typeof raw["content"] === "string" ? raw["content"] : undefined;
    const postedAt = typeof raw["posted_at"] === "string" ? raw["posted_at"] : undefined;
    const likes = num(raw["likes"]);
    const replies = num(raw["replies"]);
    const shares = num(raw["shares"]);
    out.push({
      ...(typeof raw["platform"] === "string" ? { platform: raw["platform"] } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(typeof raw["url"] === "string" ? { url: raw["url"] } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
      ...(likes !== undefined ? { likes } : {}),
      ...(replies !== undefined ? { replies } : {}),
      ...(shares !== undefined ? { shares } : {}),
      isRepost: /^RT @\w+:/.test(content ?? ""),
    });
  }
  return out;
}

/**
 * The captured posts for a profile, when a fresh capture is cached (14 days).
 * Null when nothing was captured, the capture expired, or it failed.
 */
export function getCachedNewsfeed(
  url: string,
  ledger: Pick<ReturnType<typeof getLedger>, "getCachedEnrichment"> | null = null,
): CapturedNewsfeed | null {
  const canonical = newsfeedSeedUrl([url]);
  if (!canonical) return null;
  let cached: ReturnType<ReturnType<typeof getLedger>["getCachedEnrichment"]> = null;
  try {
    cached = (ledger ?? getLedger()).getCachedEnrichment(newsfeedCacheKey(canonical));
  } catch {
    return null;
  }
  if (!cached || cached.status === "failed") return null;
  if (Date.now() - new Date(cached.fetched_at).getTime() >= NEWSFEED_CACHE_TTL_MS) return null;
  try {
    return {
      url: canonical,
      fetchedAt: new Date(cached.fetched_at).toISOString(),
      posts: newsfeedPostsFrom(JSON.parse(cached.result_json)),
    };
  } catch {
    return null;
  }
}
