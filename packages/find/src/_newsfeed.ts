import {
  dailySpendStatus,
  demoMode,
  triggerConfigForSource,
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
  newsfeedCacheKey,
  newsfeedPostsFrom,
  newsfeedSeedUrl,
  getCachedNewsfeed as readCachedNewsfeed,
  type CallContext,
  type CapturedNewsfeed,
  type PersonResearchNewsfeed,
} from "@oneshot-gtm/core";

/**
 * Newsfeed capture: a person's recent posts, bought once per profile and kept
 * for later use. Nothing drafts from them yet. The dossier carries only a
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

// The read side (seed URL, cache key, parsing, lookup) moved to core so plays
// can read posts; re-exported here for existing importers.
export {
  canonicalXProfileUrl,
  newsfeedCacheKey,
  newsfeedSeedUrl,
  type CapturedNewsfeed,
  type NewsfeedPost,
} from "@oneshot-gtm/core";

export const NEWSFEED_COST_ESTIMATE_USD = 0.07;

/**
 * The captured posts for a profile, when a fresh capture is cached (14 days).
 * Null when nothing was captured, the capture expired, or it failed.
 */
export function getCachedNewsfeed(url: string): CapturedNewsfeed | null {
  return readCachedNewsfeed(url, getLedger());
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
 * `cacheOnly` answers from the cache or not at all. It never calls.
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
          posts: newsfeedPostsFrom(JSON.parse(cached.result_json)),
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
            posts: newsfeedPostsFrom(out.result),
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

// --- when captures run: on approval, and for prospects in flight ---------

/** A trigger's `personNewsfeed: false` switches capture off for its rows; anything else keeps it on. */
export function newsfeedOffForSource(source: string | null | undefined): boolean {
  return triggerConfigForSource(source)?.["personNewsfeed"] === false;
}

/**
 * True when the cache already answers for this profile: posts younger than
 * the 14-day TTL, or a genuine failure still inside its negative-cache
 * window. A missing, expired or unreadable entry is not fresh.
 */
export function hasFreshNewsfeed(url: string, now = Date.now()): boolean {
  let cached: ReturnType<ReturnType<typeof getLedger>["getCachedEnrichment"]> = null;
  try {
    cached = getLedger().getCachedEnrichment(newsfeedCacheKey(url));
  } catch {
    return false;
  }
  if (!cached) return false;
  const ageMs = now - new Date(cached.fetched_at).getTime();
  if (!Number.isFinite(ageMs)) return false;
  return cached.status === "failed" ? ageMs < ENRICH_FAILURE_TTL_MS : ageMs < NEWSFEED_CACHE_TTL_MS;
}

export interface ApprovalCaptureResult {
  captured: number;
  cached: number;
  skipped: number;
  failed: number;
  costUsd: number;
}

/**
 * Capture posts for rows the founder just approved. Most new rows are
 * rejected, so capture waits for approval rather than paying for every row
 * a finder creates. One at a time through the newsfeed lane; the daily spend
 * ceiling and the 14-day cache are `safePersonNewsfeed`'s. A row that left
 * `approved` before its turn (sent, rejected) is skipped, and a row whose
 * trigger switched `personNewsfeed` off is never captured.
 */
export async function captureNewsfeedOnApproval(
  rowIds: readonly number[],
): Promise<ApprovalCaptureResult> {
  const result: ApprovalCaptureResult = {
    captured: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    costUsd: 0,
  };
  if (demoMode()) {
    result.skipped = rowIds.length;
    return result;
  }
  const ledger = getLedger();
  for (const id of rowIds) {
    try {
      const row = ledger.getQueueRow(id);
      if (!row || row.status !== "approved" || newsfeedOffForSource(row.source)) {
        result.skipped++;
        continue;
      }
      const attached = await captureNewsfeedForQueueRow(id, row.play_name);
      const outcome = attached?.outcome;
      if (!outcome || outcome.status === "skipped") {
        result.skipped++;
        // The spend ceiling or an open breaker holds for the rest of the batch.
        if (outcome?.status === "skipped" && outcome.reason !== "no-profile") break;
        continue;
      }
      result.costUsd += outcome.costUsd;
      if (outcome.status === "failed") result.failed++;
      else if (outcome.cached) result.cached++;
      else result.captured++;
    } catch (err) {
      result.failed++;
      logEvent(
        "error.swallowed",
        {
          kind: "newsfeed.on_approve",
          queue_id: id,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }
  logEvent("newsfeed.on_approve", { rows: rowIds.length, ...result });
  return result;
}

/**
 * Fire-and-forget `captureNewsfeedOnApproval`: an approval returns at once,
 * and a capture that fails never reaches the approve path.
 */
export function scheduleNewsfeedOnApproval(rowIds: readonly number[]): void {
  if (rowIds.length === 0) return;
  void captureNewsfeedOnApproval(rowIds).catch((err: unknown) => {
    logEvent(
      "error.swallowed",
      {
        kind: "newsfeed.on_approve",
        message_120: ((err as Error | undefined)?.message ?? "").slice(0, 120),
      },
      "warn",
    );
  });
}

/** Prospects per in-flight sweep. The newsfeed lane is one at a time, ~5-12 s a call. */
export const IN_FLIGHT_NEWSFEED_MAX = 25;

export interface InFlightNewsfeedCandidate {
  prospectId: number;
  playName: string;
  url: string;
}

/**
 * Pure: which prospects in a running cadence want posts, oldest enrolment
 * first. One entry per prospect (its earliest active cadence); a prospect
 * with no LinkedIn/X profile, a fresh cache entry, or a trigger that switched
 * `personNewsfeed` off is left out.
 */
export function selectInFlightNewsfeedCandidates(
  cadences: ReadonlyArray<{ prospect_id: number; play_name: string; enrolled_at: string }>,
  deps: {
    seedFor: (prospectId: number) => string | null;
    isFresh: (url: string) => boolean;
    offFor: (prospectId: number, playName: string) => boolean;
  },
): InFlightNewsfeedCandidate[] {
  const ordered = cadences.toSorted(
    (a, b) => a.enrolled_at.localeCompare(b.enrolled_at) || a.prospect_id - b.prospect_id,
  );
  const seen = new Set<number>();
  const out: InFlightNewsfeedCandidate[] = [];
  for (const c of ordered) {
    if (seen.has(c.prospect_id)) continue;
    seen.add(c.prospect_id);
    const url = deps.seedFor(c.prospect_id);
    if (!url || deps.isFresh(url) || deps.offFor(c.prospect_id, c.play_name)) continue;
    out.push({ prospectId: c.prospect_id, playName: c.play_name, url });
  }
  return out;
}

export interface InFlightNewsfeedSweepResult {
  ran: boolean;
  candidates: number;
  captured: number;
  failed: number;
  costUsd: number;
  stoppedBy?: "max-prospects" | "deadline" | "spend-ceiling" | "circuit-open";
}

/**
 * The scheduler's refresh for conversations in flight: prospects with an
 * active cadence whose posts are missing or older than the cache TTL, oldest
 * enrolment first, at most `maxProspects` a sweep. Stops at the deadline, the
 * daily spend ceiling, or an open breaker. The opt-out is read from the
 * trigger the prospect's sent intro came from.
 */
export async function sweepInFlightNewsfeeds(
  opts: { maxProspects?: number; deadlineAt?: number } = {},
): Promise<InFlightNewsfeedSweepResult> {
  const result: InFlightNewsfeedSweepResult = {
    ran: false,
    candidates: 0,
    captured: 0,
    failed: 0,
    costUsd: 0,
  };
  if (demoMode()) return result;
  const ledger = getLedger();
  const cadences = ledger.listActiveCadences();
  const emailById = new Map(cadences.map((c) => [c.prospect_id, c.prospect_email]));
  const candidates = selectInFlightNewsfeedCandidates(cadences, {
    seedFor: (id) => {
      const p = ledger.getProspectById(id);
      return p ? newsfeedSeedForProspect(p) : null;
    },
    isFresh: (url) => hasFreshNewsfeed(url),
    offFor: (id, playName) => {
      const email = emailById.get(id);
      const source = email ? (ledger.latestSentQueueRow(playName, email)?.source ?? null) : null;
      return newsfeedOffForSource(source);
    },
  });
  result.ran = true;
  result.candidates = candidates.length;
  const maxProspects = opts.maxProspects ?? IN_FLIGHT_NEWSFEED_MAX;
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  for (const [index, c] of candidates.entries()) {
    if (index >= maxProspects) {
      result.stoppedBy = "max-prospects";
      break;
    }
    if (Date.now() >= deadlineAt) {
      result.stoppedBy = "deadline";
      break;
    }
    const attached = await captureNewsfeedForProspect(c.prospectId, c.playName);
    const outcome = attached?.outcome;
    if (!outcome) continue;
    if (outcome.status === "skipped") {
      if (outcome.reason === "spend-ceiling" || outcome.reason === "circuit-open") {
        result.stoppedBy = outcome.reason;
        break;
      }
      continue;
    }
    result.costUsd += outcome.costUsd;
    if (outcome.status === "failed") result.failed++;
    else result.captured++;
  }
  logEvent("newsfeed.in_flight_sweep", {
    candidates: result.candidates,
    captured: result.captured,
    failed: result.failed,
    cost_usd: result.costUsd,
    stopped_by: result.stoppedBy ?? null,
  });
  return result;
}
