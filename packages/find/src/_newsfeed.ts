import {
  canonicalLinkedInProfileKey,
  dailySpendStatus,
  ENRICH_FAILURE_TTL_MS,
  getLedger,
  isPersonResearchDossier,
  isTransientToolError,
  logEvent,
  NEWSFEED_CACHE_TTL_MS,
  NEWSFEED_DEADLINE_MS,
  personNewsfeed,
  readPersonHalf,
  withDeadline,
  type CallContext,
  type PersonResearchNewsfeed,
} from "@oneshot-gtm/core";

/**
 * Newsfeed capture: a person's recent posts, bought once per profile and kept
 * for later use. Nothing drafts from them yet — the dossier carries only a
 * pointer (`PersonResearchNewsfeed`), and the posts live in the shared
 * enrichment cache under `newsfeed:<canonical url>` for 14 days, readable by
 * `getCachedNewsfeed`. Measured 2026-09-27: LinkedIn 8/8 non-empty (7/8 with
 * a post inside 90 days), X 4/4 but mostly reposts.
 *
 * The tool is rate-limited per wallet (a burst of 12 parallel calls was all
 * 429 `retry_after: 60`), so every call here runs one at a time, a 429 waits
 * out `retry_after` and retries at most twice, and neither a 429 nor any
 * other transient error is ever negative-cached.
 */

export const NEWSFEED_COST_ESTIMATE_USD = 0.07;

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

/** Seed for a queue payload: its own LinkedIn/X keys, then the dossier's provider LinkedIn URL. */
export function newsfeedSeedForPayload(payload: JsonRecord): string | null {
  const research = payload["personResearch"];
  const dossier = isPersonResearchDossier(research) ? research : null;
  return newsfeedSeedUrl([
    payload["linkedinUrl"],
    dossier?.linkedinUrl,
    payload["sourceProfileUrl"],
    payload["profileUrl"],
    payload["authorUrl"],
    payload["twitterUrl"],
    payload["xUrl"],
  ]);
}

/** Seed for a prospect: its profile columns, then the researched person half's LinkedIn URL. */
export function newsfeedSeedForProspect(p: {
  linkedin_url: string | null;
  source_profile_url: string | null;
  dossier_json: string | null;
}): string | null {
  const half = readPersonHalf(p.dossier_json);
  const researched = isRecord(half) ? half["linkedinUrl"] : undefined;
  return newsfeedSeedUrl([p.linkedin_url, researched, p.source_profile_url]);
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

function postsFrom(result: unknown): NewsfeedPost[] {
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

/** The dossier pointer for a capture: never the posts. */
export function newsfeedPointer(feed: CapturedNewsfeed): PersonResearchNewsfeed {
  let newest: number | null = null;
  for (const p of feed.posts) {
    const t = Date.parse(p.postedAt ?? "");
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return {
    url: feed.url,
    fetchedAt: feed.fetchedAt,
    count: feed.posts.length,
    ...(newest !== null ? { newestAt: new Date(newest).toISOString() } : {}),
  };
}

/**
 * The captured posts for a profile, when a fresh capture is cached (14 days).
 * Null when nothing was captured, the capture expired, or it failed.
 */
export function getCachedNewsfeed(url: string): CapturedNewsfeed | null {
  const canonical = newsfeedSeedUrl([url]);
  if (!canonical) return null;
  let cached: ReturnType<ReturnType<typeof getLedger>["getCachedEnrichment"]> = null;
  try {
    cached = getLedger().getCachedEnrichment(newsfeedCacheKey(canonical));
  } catch {
    return null;
  }
  if (!cached || cached.status === "failed") return null;
  if (Date.now() - new Date(cached.fetched_at).getTime() >= NEWSFEED_CACHE_TTL_MS) return null;
  try {
    return {
      url: canonical,
      fetchedAt: new Date(cached.fetched_at).toISOString(),
      posts: postsFrom(JSON.parse(cached.result_json)),
    };
  } catch {
    return null;
  }
}

// --- serialization, 429 back-off, breaker ---------------------------------

let chain: Promise<unknown> = Promise.resolve();
/**
 * One newsfeed call at a time, process-wide, whatever the caller's
 * concurrency. The slot is held until the platform call itself settles, not
 * until the caller stops waiting: a call abandoned at the deadline is still
 * running (and billing), and the next one must not overlap it.
 */
function serialized<T>(fn: (hold: (live: Promise<unknown>) => void) => Promise<T>): Promise<T> {
  let held: Promise<unknown> = Promise.resolve();
  const run = (): Promise<T> =>
    fn((live) => {
      held = live.then(
        () => undefined,
        () => undefined,
      );
    });
  const next = chain.then(run, run);
  chain = next.then(
    () => held,
    () => held,
  );
  return next;
}

let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Test-only: replace the back-off sleep. */
export function _setNewsfeedSleep(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_AFTER_S = 120;

/** `retry_after` seconds from a 429, or null when the error is not a rate limit. */
export function rateLimitRetryAfterS(err: unknown): number | null {
  const e = err as { statusCode?: unknown; responseBody?: unknown; message?: unknown };
  const status = typeof e?.statusCode === "number" ? e.statusCode : null;
  const body = typeof e?.responseBody === "string" ? e.responseBody : "";
  const message = typeof e?.message === "string" ? e.message : "";
  const limited =
    status === 429 || /rate_limit_exceeded/.test(body) || /\b429\b|rate limit/i.test(message);
  if (!limited) return null;
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    if (typeof parsed.retry_after === "number" && parsed.retry_after > 0) {
      return Math.min(parsed.retry_after, MAX_RETRY_AFTER_S);
    }
  } catch {
    // no body: fall back to the limiter's window
  }
  return 60;
}

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
let consecutiveTransient = 0;
let openedAt: number | null = null;

/** True while repeated platform failures have paused newsfeed calls. */
export function isNewsfeedCircuitOpen(): boolean {
  return openedAt !== null && Date.now() - openedAt < BREAKER_COOLDOWN_MS;
}

function recordOutcome(transient: boolean): void {
  if (!transient) {
    consecutiveTransient = 0;
    openedAt = null;
    return;
  }
  consecutiveTransient++;
  if (consecutiveTransient >= BREAKER_THRESHOLD) {
    if (openedAt === null)
      logEvent("newsfeed.circuit_open", { consecutive: consecutiveTransient }, "warn");
    openedAt = Date.now();
  }
}

/** Test-only: reset serialization and breaker state. */
export function _resetNewsfeed(): void {
  chain = Promise.resolve();
  consecutiveTransient = 0;
  openedAt = null;
}

export type NewsfeedOutcome =
  | { status: "captured"; feed: CapturedNewsfeed; costUsd: number; cached: boolean }
  | {
      status: "skipped";
      reason: "not-cached" | "cost-cap" | "spend-ceiling" | "circuit-open" | "no-profile";
      costUsd: 0;
    }
  | { status: "failed"; transient: boolean; costUsd: number };

/**
 * personNewsfeed that never throws, caches, serializes and cannot hang.
 * `cacheOnly` answers from the cache or not at all — it never calls.
 */
export async function safePersonNewsfeed(
  url: string,
  ctx: CallContext,
  opts: { cacheOnly?: boolean; remainingUsd?: number } = {},
): Promise<NewsfeedOutcome> {
  const canonical = newsfeedSeedUrl([url]);
  if (!canonical) return { status: "skipped", reason: "no-profile", costUsd: 0 };
  const key = newsfeedCacheKey(canonical);
  const ledger = getLedger();
  let cached: ReturnType<typeof ledger.getCachedEnrichment> = null;
  try {
    cached = ledger.getCachedEnrichment(key);
  } catch {
    // cache-read failure = miss
  }
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (cached.status === "failed") {
      if (ageMs < ENRICH_FAILURE_TTL_MS) return { status: "failed", transient: false, costUsd: 0 };
    } else if (ageMs < NEWSFEED_CACHE_TTL_MS) {
      try {
        const feed = {
          url: canonical,
          fetchedAt: new Date(cached.fetched_at).toISOString(),
          posts: postsFrom(JSON.parse(cached.result_json)),
        };
        return { status: "captured", feed, costUsd: 0, cached: true };
      } catch {
        // corrupt row: refetch
      }
    }
  }
  if (opts.cacheOnly) return { status: "skipped", reason: "not-cached", costUsd: 0 };
  if (opts.remainingUsd !== undefined && opts.remainingUsd < NEWSFEED_COST_ESTIMATE_USD) {
    return { status: "skipped", reason: "cost-cap", costUsd: 0 };
  }
  try {
    if (dailySpendStatus().ceilingReached) {
      return { status: "skipped", reason: "spend-ceiling", costUsd: 0 };
    }
  } catch {
    // an unreadable spend status never blocks; the run-level gate still holds
  }
  if (isNewsfeedCircuitOpen()) return { status: "skipped", reason: "circuit-open", costUsd: 0 };

  return serialized(async (hold) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const live = personNewsfeed({ socialMediaUrl: canonical }, ctx);
        hold(live);
        // The cache write rides the live promise: a call that outlives the
        // deadline was still paid for and must reach the cache.
        live.then(
          (out) => {
            try {
              ledger.setCachedEnrichment(key, JSON.stringify(out.result));
            } catch {
              // best-effort
            }
          },
          () => undefined,
        );
        const out = await withDeadline(live, NEWSFEED_DEADLINE_MS, "personNewsfeed");
        recordOutcome(false);
        const costUsd = out.receiptId !== 0 ? (out.result.cost ?? 0) : 0;
        return {
          status: "captured" as const,
          feed: {
            url: canonical,
            fetchedAt: new Date().toISOString(),
            posts: postsFrom(out.result),
          },
          costUsd,
          cached: false,
        };
      } catch (err) {
        const retryAfterS = rateLimitRetryAfterS(err);
        if (retryAfterS !== null && attempt < MAX_RATE_LIMIT_RETRIES) {
          logEvent("newsfeed.rate_limited", { retry_after_s: retryAfterS, attempt });
          await sleep(retryAfterS * 1000);
          continue;
        }
        const transient = retryAfterS !== null || isTransientToolError(err);
        logEvent(
          "error.swallowed",
          {
            kind: `${ctx.playName}.person_newsfeed`,
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
        recordOutcome(transient);
        // Only a genuine failure is negative-cached; a rate limit or an outage
        // would otherwise hide this person's feed for days after recovery.
        if (!transient) {
          try {
            ledger.setCachedEnrichmentFailure(key, (err as Error).message ?? "newsfeed failed");
          } catch {
            // best-effort
          }
        }
        return { status: "failed" as const, transient, costUsd: 0 };
      }
    }
  });
}

// --- attach the pointer, after the dossier is written ----------------------

export interface AttachResult {
  outcome: NewsfeedOutcome;
  /** The pointer was written onto the row's dossier. */
  attached: boolean;
}

/**
 * Capture a queue row's newsfeed and patch the pointer into its
 * `personResearch`. Runs after the dossier write, so a slow or failed feed
 * never costs the row its research. A row without a dossier keeps the posts
 * in the cache only; a sent row refuses the patch (`patchLiveQueuePayload`).
 */
export async function captureNewsfeedForQueueRow(
  rowId: number,
  playName: string,
  opts: { cacheOnly?: boolean; remainingUsd?: number } = {},
): Promise<AttachResult | null> {
  const ledger = getLedger();
  const row = ledger.getQueueRow(rowId);
  if (!row) return null;
  let payload: JsonRecord;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    payload = isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
  const url = newsfeedSeedForPayload(payload);
  if (!url) return null;
  const outcome = await safePersonNewsfeed(
    url,
    {
      playName,
      memo: "person research: recent posts, kept for later",
      decisionContext: { source: "person-research", queueId: rowId },
    },
    opts,
  );
  if (outcome.status !== "captured" || !isPersonResearchDossier(payload["personResearch"])) {
    return { outcome, attached: false };
  }
  // The capture is paid for by now: a failed pointer write must still hand
  // back its cost, or the caller's cap under-counts.
  try {
    const attached = ledger.patchLiveQueuePayload({
      id: rowId,
      patch: { personResearch: { newsfeed: newsfeedPointer(outcome.feed) } },
    });
    return { outcome, attached };
  } catch {
    return { outcome, attached: false };
  }
}

/** The prospect twin of `captureNewsfeedForQueueRow`: the pointer lands in the researched person half. */
export async function captureNewsfeedForProspect(
  prospectId: number,
  playName: string,
  opts: { cacheOnly?: boolean; remainingUsd?: number } = {},
): Promise<AttachResult | null> {
  const ledger = getLedger();
  const prospect = ledger.getProspectById(prospectId);
  if (!prospect) return null;
  const url = newsfeedSeedForProspect(prospect);
  if (!url) return null;
  const outcome = await safePersonNewsfeed(
    url,
    {
      playName,
      memo: "person research: recent posts, kept for later",
      decisionContext: { source: "person-research", prospectId },
    },
    opts,
  );
  if (outcome.status !== "captured") return { outcome, attached: false };
  // Re-read: the capture can take a while, and the half must be the stored one.
  const fresh = ledger.getProspectById(prospectId);
  const half = readPersonHalf(fresh?.dossier_json ?? null);
  if (!isRecord(half) || half["source"] !== "deepResearchPerson") {
    return { outcome, attached: false };
  }
  try {
    ledger.mergeProspectDossierHalf(prospectId, "person", {
      ...half,
      newsfeed: newsfeedPointer(outcome.feed),
    });
    return { outcome, attached: true };
  } catch {
    return { outcome, attached: false };
  }
}
