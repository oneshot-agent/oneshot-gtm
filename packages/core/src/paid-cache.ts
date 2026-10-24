import { createHash } from "node:crypto";
import { demoMode } from "./demo.ts";
import { logEvent } from "./events.ts";
import { canonicalLinkedInProfileKey } from "./ledger-prospects.ts";
import { isTransientToolError, rateLimitRetryAfterS } from "./send-routing.ts";
import { getSharedDb, type SharedDb } from "./shared-db.ts";

/**
 * The one cache for paid call results. Every paid lookup wrapper (oneshot.ts)
 * asks it first, and the LinkedIn profile reads, whose answer arrives on a
 * later job poll, go through it at the read. Rows live in the SHARED db
 * (`paid_call_cache`), so a lookup bought in one workspace is free in every
 * other. Actions (sends, invites, letters, builds, browser tasks) are never
 * cached: `PAID_ACTIONS`.
 *
 * - A hit returns the stored result with `cost: 0` and `receiptId: 0`, writes
 *   no receipt, and bumps the row's hit and savings counters.
 * - Only a successful result is stored. A thrown error that is a genuine
 *   verdict (not transient, not a rate limit, not our wallet or input) is
 *   kept as a negative entry for the type's failure expiry, and a hit on it
 *   rethrows `CachedPaidFailureError`.
 * - Concurrent calls for one key in this process share one purchase.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** How long a genuine failure keeps a lookup from being bought again: long enough to ride out a bad input, short enough to self-heal. */
export const PAID_FAILURE_TTL_MS = 3 * DAY;

export interface PaidLookupSpec {
  /** How long a stored result answers. */
  ttlMs: number;
  /** How long a negative entry answers; 0 never stores one. */
  failureTtlMs: number;
  /** Which part of the input names the thing bought. Defaults to the whole input. */
  identity?: (input: Record<string, unknown>) => unknown;
  /** More inputs the same result answers (an enrich by LinkedIn URL that surfaced the email). */
  aliases?: (result: unknown) => unknown[];
  /** Whether a result is worth keeping. Defaults to: an object whose status is not failed/error. */
  storable?: (result: unknown) => boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** A person is the same person whatever case their profile URL arrives in. */
function personUrl(v: unknown): string | undefined {
  const s = str(v);
  return s ? s.trim().toLowerCase() : undefined;
}

/** The surfaced email(s) an enrich result names: a by-email enrich of either is the same purchase. */
function enrichAliases(result: unknown): unknown[] {
  const profile = isRecord(result) && isRecord(result["profile"]) ? result["profile"] : null;
  if (!profile) return [];
  const emails = new Set<string>();
  for (const field of ["email", "best_work_email"]) {
    const e = str(profile[field])?.trim().toLowerCase();
    if (e && e.includes("@")) emails.add(e);
  }
  return [...emails].map((email) => ({ email }));
}

/** Call type → expiry and identity, for every paid LOOKUP. */
export const PAID_LOOKUPS = {
  "enrich.profile": {
    ttlMs: 30 * DAY,
    failureTtlMs: PAID_FAILURE_TTL_MS,
    // The strongest identifier names the person; the rest are hints.
    identity: (i) =>
      str(i["email"])
        ? { email: i["email"] }
        : str(i["linkedinUrl"])
          ? { linkedinUrl: personUrl(i["linkedinUrl"]) }
          : { name: i["name"], companyDomain: i["companyDomain"] },
    aliases: enrichAliases,
  },
  "research.person": {
    ttlMs: 90 * DAY,
    failureTtlMs: PAID_FAILURE_TTL_MS,
    // The social URL identifies a person more precisely than an email.
    identity: (i) =>
      str(i["socialMediaUrl"])
        ? { url: personUrl(i["socialMediaUrl"]) }
        : str(i["email"])
          ? { email: i["email"] }
          : { name: i["name"], company: i["company"] },
  },
  "research.newsfeed": {
    ttlMs: 14 * DAY,
    failureTtlMs: PAID_FAILURE_TTL_MS,
    identity: (i) => ({ url: personUrl(i["socialMediaUrl"]) }),
  },
  "email.find": {
    ttlMs: 30 * DAY,
    failureTtlMs: PAID_FAILURE_TTL_MS,
    identity: (i) => ({
      fullName:
        str(i["fullName"]) ?? [i["firstName"], i["lastName"]].filter((p) => str(p)).join(" "),
      companyDomain: i["companyDomain"],
    }),
  },
  "email.verify": {
    ttlMs: 14 * DAY,
    failureTtlMs: PAID_FAILURE_TTL_MS,
    identity: (i) => ({ email: i["email"] }),
  },
  "enrich.company": { ttlMs: 30 * DAY, failureTtlMs: PAID_FAILURE_TTL_MS },
  "research.company": { ttlMs: 30 * DAY, failureTtlMs: PAID_FAILURE_TTL_MS },
  "research.people": { ttlMs: 7 * DAY, failureTtlMs: PAID_FAILURE_TTL_MS },
  "local.resolve": { ttlMs: 30 * DAY, failureTtlMs: PAID_FAILURE_TTL_MS },
  "local.search": { ttlMs: 7 * DAY, failureTtlMs: PAID_FAILURE_TTL_MS },
  "research.deep": { ttlMs: 30 * DAY, failureTtlMs: PAID_FAILURE_TTL_MS },
  // Finders read listing pages to find new entries: half a day stops the
  // repeats across workspaces and runs, and discovery still sees each day.
  "web.read": { ttlMs: 12 * HOUR, failureTtlMs: 12 * HOUR },
  "web.search": { ttlMs: 12 * HOUR, failureTtlMs: 12 * HOUR },
  "gov.solicitations": { ttlMs: 12 * HOUR, failureTtlMs: 12 * HOUR },
  // The connected account's profile read (or its browser fallback), as the
  // parsed profile. The view is a job answered on a later poll, so it is
  // cached at the read (_linkedin-profile.ts), not at the wrapper.
  "linkedin.profile_read": {
    ttlMs: 30 * DAY,
    failureTtlMs: PAID_FAILURE_TTL_MS,
    identity: (i) => ({ url: i["url"] }),
    storable: (r) => isRecord(r),
  },
  // The plain silent view a cadence reads a headline and current company from
  // (_linkedin-evidence.ts). Its errors are about the account, never the
  // person, so no negative entry.
  "linkedin.profile": {
    ttlMs: 30 * DAY,
    failureTtlMs: 0,
    identity: (i) => ({ url: i["url"] }),
    storable: (r) => isRecord(r),
  },
} satisfies Record<string, PaidLookupSpec>;

export type PaidLookupType = keyof typeof PAID_LOOKUPS;

/** Paid calls that DO something. Never cached: a second call is a second action. */
export const PAID_ACTIONS = [
  "email.send",
  "email.reply",
  "sms.send",
  "voice.call",
  "build.website",
  // Agentic, and often acts. Its one read path (the LinkedIn profile read) is
  // cached at the read as linkedin.profile_read.
  "browser.task",
  "linkedin.sync",
  "linkedin.reply",
  "linkedin.message",
  "linkedin.invite",
  "linkedin.withdraw",
] as const;

/** How long a stored result of this lookup answers. */
export function paidLookupTtlMs(callType: PaidLookupType): number {
  return PAID_LOOKUPS[callType].ttlMs;
}

export interface PaidCacheOptions {
  /** Skip the read (buy now) but still store the result. */
  fresh?: boolean;
  /** Answer from a stored result younger than this instead of the type's expiry. */
  maxAgeMs?: number;
  /** Never buy: a miss throws `PaidCacheMissError`. */
  cacheOnly?: boolean;
}

/** How a result was answered from the cache. */
export interface PaidCacheHit {
  fetchedAt: string;
  /** Joined a purchase already running in this process. */
  joined?: boolean;
}

/** `cacheOnly` and nothing stored for the input. */
export class PaidCacheMissError extends Error {
  constructor(callType: string) {
    super(`${callType}: not in the paid-call cache`);
    this.name = "PaidCacheMissError";
  }
}

/** A negative entry answered: the same input failed for real inside the failure expiry. */
export class CachedPaidFailureError extends Error {
  readonly fetchedAt: string;
  constructor(message: string, fetchedAt: string) {
    super(message);
    this.name = "CachedPaidFailureError";
    this.fetchedAt = fetchedAt;
  }
}

export function isPaidCacheMiss(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "PaidCacheMissError";
}

export function isCachedPaidFailure(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "CachedPaidFailureError";
}

// --- the key ---------------------------------------------------------------

/** Never part of the key: how long to wait is not what was bought. */
const EXCLUDED_FIELDS = new Set(["timeoutMs", "timeoutSec", "memo", "ctx", "decisionContext"]);

function canonicalUrl(raw: string): string {
  const s = raw.trim();
  const linkedin = canonicalLinkedInProfileKey(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  if (linkedin) return linkedin;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return s.toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const social = /(^|\.)(linkedin|github|x|twitter)\.com$/.test(host);
  // A listing page's query is part of the page; a profile's is tracking.
  const search = social ? "" : url.search;
  const path = url.pathname.replace(/\/+$/, "");
  const out = `${host}${url.port ? `:${url.port}` : ""}${path}${search}`;
  return social ? out.toLowerCase() : out;
}

function canonicalDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

function normalise(value: unknown, field = ""): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    if (/url$/i.test(field)) return canonicalUrl(s);
    if (/domains?$/i.test(field)) return canonicalDomain(s);
    return s.replace(/\s+/g, " ").toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .map((v) => normalise(v, field))
      .filter((v) => v !== undefined)
      .map((v) => stableStringify(v));
    const unique = [...new Set(items)].toSorted();
    return unique.length ? unique.map((v) => JSON.parse(v) as unknown) : undefined;
  }
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(value)) {
      if (EXCLUDED_FIELDS.has(k)) continue;
      const n = normalise(v, k);
      if (n !== undefined) out[k] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `callType:sha256(normalised identity)`: the same lookup, however its input was spelled. */
export function paidCacheKey(callType: PaidLookupType, input: unknown): string {
  const spec: PaidLookupSpec = PAID_LOOKUPS[callType];
  const raw = isRecord(input) ? input : {};
  const identity = spec.identity ? spec.identity(raw) : raw;
  const canonical = stableStringify(normalise(identity) ?? {});
  return `${callType}:${createHash("sha256").update(canonical).digest("hex")}`;
}

// --- reads and writes -------------------------------------------------------

/** The shared db, with the legacy enrichment_cache rows copied in once per file. */
function db(): SharedDb {
  const shared = getSharedDb();
  if (!imported.has(shared)) {
    imported.add(shared);
    try {
      importLegacyPaidResults(shared);
    } catch (err) {
      logEvent(
        "paid_cache.import_failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }
  }
  return shared;
}
const imported = new WeakSet<SharedDb>();

function costOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const c = value["cost"];
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

/** The stored result, re-read as free: every cost field it carries reads 0. */
function asFree<R>(result: R): R {
  if (!isRecord(result)) return result;
  const out: JsonRecord = { ...result };
  for (const field of ["cost", "billed_cost", "total_cost_usd"]) {
    if (field in out) out[field] = 0;
  }
  return out as R;
}

function defaultStorable(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const status = typeof result["status"] === "string" ? result["status"].toLowerCase() : "";
  return status !== "failed" && status !== "error";
}

/**
 * Whether a thrown error is a verdict about the input worth remembering.
 * Never: a transient platform or network error, a rate limit, a refusal of
 * the call itself (validation, a missing or unfunded wallet, auth), or the
 * cache's own answers.
 */
export function isNegativeCacheable(err: unknown): boolean {
  if (!err || isPaidCacheMiss(err) || isCachedPaidFailure(err)) return false;
  if (isTransientToolError(err) || rateLimitRetryAfterS(err) !== null) return false;
  const e = err as { name?: unknown; statusCode?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  if (/Validation|Payment|Abort|Auth/i.test(name)) return false;
  if (typeof e.statusCode === "number" && [400, 401, 402, 403, 408].includes(e.statusCode))
    return false;
  const message = typeof e.message === "string" ? e.message : String(err);
  return !/credentials|wallet|unauthori[sz]ed|forbidden|api key/i.test(message);
}

/** One stored entry for an input, if any: the result or a negative entry, with when it was bought. */
export type PaidCacheEntry =
  | { status: "ok"; result: unknown; fetchedAt: string; costUsd: number | null }
  | { status: "failed"; message: string; fetchedAt: string };

/**
 * Read the stored entry for an input without counting a hit (display, a
 * cheap "is it cached" check). Expired entries come back null unless
 * `maxAgeMs` reaches them; `Infinity` reads any age.
 */
export function readPaidCache(
  callType: PaidLookupType,
  input: unknown,
  opts: { maxAgeMs?: number; now?: number } = {},
): PaidCacheEntry | null {
  if (demoMode()) return null;
  return readKey(callType, paidCacheKey(callType, input), opts);
}

function readKey(
  callType: PaidLookupType,
  key: string,
  opts: { maxAgeMs?: number; now?: number },
): PaidCacheEntry | null {
  const spec: PaidLookupSpec = PAID_LOOKUPS[callType];
  let row: ReturnType<SharedDb["getPaidCache"]> = null;
  try {
    row = db().getPaidCache(key);
  } catch {
    return null; // a cache read failure is a miss, never a lookup failure
  }
  if (!row) return null;
  const age = (opts.now ?? Date.now()) - Date.parse(row.fetched_at);
  if (!Number.isFinite(age)) return null;
  try {
    if (row.status === "failed") {
      if (age >= spec.failureTtlMs) return null;
      const message = (JSON.parse(row.result_json) as { message?: unknown }).message;
      return {
        status: "failed",
        message: typeof message === "string" ? message : "failed",
        fetchedAt: row.fetched_at,
      };
    }
    if (age >= (opts.maxAgeMs ?? spec.ttlMs)) return null;
    return {
      status: "ok",
      result: JSON.parse(row.result_json) as unknown,
      fetchedAt: row.fetched_at,
      costUsd: row.cost_usd,
    };
  } catch {
    return null; // a corrupt row is a miss
  }
}

/** True when a lookup would be answered for free: a stored result, or (with `includeFailures`) a live negative entry. */
export function hasCached(
  callType: PaidLookupType,
  input: unknown,
  opts: { maxAgeMs?: number; includeFailures?: boolean; now?: number } = {},
): boolean {
  const entry = readPaidCache(callType, input, opts);
  if (!entry) return false;
  return entry.status === "ok" || opts.includeFailures === true;
}

/** Successful results of one lookup stored since `sinceIso`, across workspaces. */
export function countPaidResultsSince(callType: PaidLookupType, sinceIso: string): number {
  return db().countPaidCacheSince(callType, sinceIso);
}

const inFlight = new Map<string, Promise<{ result: unknown; receiptId: number }>>();

/**
 * Answer a paid lookup from the cache, or buy it with `buy` and keep the
 * result. `buy` returns the wrapper's `{ result, receiptId }` (and may name
 * `costUsd` when the result carries no `cost`). Cache failures never fail the
 * lookup: a read error is a miss and a write error is logged.
 */
export async function withPaidCache<T extends { result: unknown; receiptId: number }>(
  callType: PaidLookupType,
  input: unknown,
  opts: PaidCacheOptions | undefined,
  buy: () => Promise<T>,
): Promise<T & { cached?: PaidCacheHit }> {
  if (demoMode()) return buy();
  const spec: PaidLookupSpec = PAID_LOOKUPS[callType];
  const key = paidCacheKey(callType, input);
  if (!opts?.fresh) {
    const entry = readKey(
      callType,
      key,
      opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {},
    );
    if (entry?.status === "failed") {
      logEvent("paid_cache.negative_hit", { call_type: callType });
      throw new CachedPaidFailureError(entry.message, entry.fetchedAt);
    }
    if (entry?.status === "ok") {
      const savedUsd = entry.costUsd ?? 0;
      try {
        db().recordPaidCacheHit(key, callType, savedUsd);
      } catch {
        // the counters are best-effort
      }
      logEvent("paid_cache.hit", { call_type: callType, saved_usd: savedUsd });
      return {
        result: asFree(entry.result),
        receiptId: 0,
        cached: { fetchedAt: entry.fetchedAt },
      } as T & { cached?: PaidCacheHit };
    }
  }
  if (opts?.cacheOnly) throw new PaidCacheMissError(callType);

  const running = inFlight.get(key);
  if (running) {
    const out = await running;
    logEvent("paid_cache.hit", {
      call_type: callType,
      saved_usd: costOf(out.result) ?? 0,
      joined: true,
    });
    return {
      ...out,
      result: asFree(JSON.parse(JSON.stringify(out.result ?? null)) as unknown),
      receiptId: 0,
      cached: { fetchedAt: new Date().toISOString(), joined: true },
    } as T & { cached?: PaidCacheHit };
  }

  const live = (async (): Promise<T> => {
    try {
      const out = await buy();
      const named = (out as { costUsd?: unknown }).costUsd;
      const costUsd = typeof named === "number" ? named : costOf(out.result);
      try {
        const shared = db();
        const storable = (spec.storable ?? defaultStorable)(out.result);
        // A purchase is what was billed or kept: a skipped read is neither.
        if (storable || (costUsd ?? 0) > 0) shared.recordPaidCachePurchase(callType, costUsd ?? 0);
        if (storable) {
          const resultJson = JSON.stringify(out.result);
          shared.setPaidCache({ key, callType, status: "ok", resultJson, costUsd });
          for (const alias of spec.aliases?.(out.result) ?? []) {
            const aliasKey = paidCacheKey(callType, alias);
            if (aliasKey !== key)
              shared.setPaidCache({ key: aliasKey, callType, status: "ok", resultJson, costUsd });
          }
        }
      } catch (err) {
        logEvent(
          "paid_cache.write_failed",
          { call_type: callType, message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      return out;
    } catch (err) {
      if (spec.failureTtlMs > 0 && isNegativeCacheable(err)) {
        try {
          // A refresh that failed never erases a result that still answers.
          if (readKey(callType, key, {})?.status !== "ok")
            db().setPaidCache({
              key,
              callType,
              status: "failed",
              resultJson: JSON.stringify({ message: ((err as Error).message ?? "").slice(0, 300) }),
              costUsd: null,
            });
        } catch {
          // best-effort: the next call simply tries again
        }
      }
      throw err;
    }
  })();
  inFlight.set(key, live);
  const forget = () => {
    if (inFlight.get(key) === live) inFlight.delete(key);
  };
  live.then(forget, forget);
  return live;
}

/** Test hook: forget purchases in flight and every stored result and tally. */
export function _resetPaidCache(): void {
  inFlight.clear();
  db().clearPaidCache();
}

// --- the one-time copy of the old per-site rows -----------------------------

const LEGACY_IMPORT = "paid_call_cache:enrichment_cache";

export interface LegacyImportCounts {
  /** Rows per call type that would be (or were) written, positive and negative. */
  byType: Record<string, { ok: number; failed: number }>;
  /** Rows left alone: markers, gates, derived records, unreadable keys. */
  skipped: number;
  /** Rows whose key the central cache already held. */
  existing: number;
}

/** Which central lookup an old enrichment_cache key was, and its input. */
export function legacyKeyInput(
  key: string,
): { callType: PaidLookupType; input: Record<string, unknown> } | null {
  const rest = (prefix: string) => key.slice(prefix.length).trim();
  if (key.startsWith("person:")) {
    const v = rest("person:");
    if (!v) return null;
    return {
      callType: "research.person",
      input: v.includes("@") && !v.includes("/") ? { email: v } : { socialMediaUrl: v },
    };
  }
  if (key.startsWith("newsfeed:")) {
    const v = rest("newsfeed:");
    return v ? { callType: "research.newsfeed", input: { socialMediaUrl: v } } : null;
  }
  if (key.startsWith("linkedin-profile:")) {
    const v = rest("linkedin-profile:");
    // `linkedin-profile:incomplete:<hash>:<ms>` counts a charged read; it is not one.
    if (!v || v.startsWith("incomplete:")) return null;
    return { callType: "linkedin.profile_read", input: { url: v } };
  }
  if (key.startsWith("linkedin-view:")) {
    const v = rest("linkedin-view:");
    return v ? { callType: "linkedin.profile", input: { url: v } } : null;
  }
  // A bare address is an enrichProfile result (by email, or by LinkedIn URL
  // filed under the email it surfaced).
  if (!key.includes(":") && /^[^\s@]+@[^\s@]+$/.test(key)) {
    return { callType: "enrich.profile", input: { email: key } };
  }
  return null;
}

/**
 * Copy the results the per-site caches bought (in the shared
 * `enrichment_cache`) into `paid_call_cache`, under the keys the central
 * cache computes for the same input, keeping each row's original fetched_at
 * so expiry still counts from the purchase. Failed rows become negative
 * entries. Rows the central cache already holds win. Runs once per shared
 * file (recorded in legacy_imports); the old rows stay where they are.
 * `dryRun` counts without writing or recording.
 */
export function importLegacyPaidResults(
  shared: SharedDb,
  opts: { dryRun?: boolean } = {},
): LegacyImportCounts | null {
  const counts: LegacyImportCounts = { byType: {}, skipped: 0, existing: 0 };
  const seen = new Set<string>();
  const run = () => {
    // Old keys spelled one input several ways (www, a trailing slash); the
    // first write wins, so a result goes before a failure and newer first.
    const rows = shared
      .allCachedEnrichment()
      .toSorted(
        (x, y) =>
          Number(x.status === "failed") - Number(y.status === "failed") ||
          y.fetched_at.localeCompare(x.fetched_at),
      );
    for (const row of rows) {
      const mapped = legacyKeyInput(row.email);
      if (!mapped) {
        counts.skipped++;
        continue;
      }
      const failed = row.status === "failed";
      let costUsd: number | null = null;
      if (!failed) {
        try {
          costUsd = costOf(JSON.parse(row.result_json));
        } catch {
          counts.skipped++;
          continue;
        }
      }
      const key = paidCacheKey(mapped.callType, mapped.input);
      const tally = (counts.byType[mapped.callType] ??= { ok: 0, failed: 0 });
      if (opts.dryRun) {
        // Two old keys can name one input; the write keeps the first, so the count does too.
        if (seen.has(key) || shared.getPaidCache(key)) counts.existing++;
        else tally[failed ? "failed" : "ok"]++;
        seen.add(key);
        continue;
      }
      const wrote = shared.setPaidCache(
        {
          key,
          callType: mapped.callType,
          status: failed ? "failed" : "ok",
          resultJson: row.result_json,
          costUsd,
          fetchedAt: row.fetched_at,
        },
        { keepExisting: true },
      );
      if (wrote) tally[failed ? "failed" : "ok"]++;
      else counts.existing++;
    }
  };
  if (opts.dryRun) {
    run();
    return counts;
  }
  if (!shared.runOnce(LEGACY_IMPORT, run)) return null;
  logEvent("paid_cache.legacy_import", {
    skipped: counts.skipped,
    existing: counts.existing,
    ...Object.fromEntries(
      Object.entries(counts.byType).map(([t, c]) => [t.replace(/\W/g, "_"), c.ok + c.failed]),
    ),
  });
  return counts;
}

// --- reporting ---------------------------------------------------------------

export interface PaidCacheStat {
  callType: string;
  hits: number;
  savedUsd: number;
  purchases: number;
  spentUsd: number;
  /** hits / (hits + purchases); null with neither. */
  servedShare: number | null;
}

/** Per call type over the last `days` (all workspaces): answers from the cache, dollars saved, purchases. */
export function paidCacheStats(days = 7, now = new Date()): PaidCacheStat[] {
  const since = new Date(now.getTime() - (days - 1) * DAY).toISOString().slice(0, 10);
  return db()
    .paidCacheDaily(since)
    .map((r) => {
      const hits = Number(r.hits ?? 0);
      const purchases = Number(r.purchases ?? 0);
      return {
        callType: r.call_type,
        hits,
        savedUsd: Number(r.saved_usd ?? 0),
        purchases,
        spentUsd: Number(r.spent_usd ?? 0),
        servedShare: hits + purchases > 0 ? hits / (hits + purchases) : null,
      };
    });
}
