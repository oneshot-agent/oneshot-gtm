/**
 * Live LinkedIn profile reads through a OneShot browser profile.
 *
 * The enrichment provider behind `deepResearchPerson` can be a year behind a
 * person's live profile (row #9144: provider said one employer "to Present",
 * the page showed a new company since March). The founder pastes their own
 * `li_at` cookie on /setup; a one-time browser task sets it inside a
 * persistent OneShot browser profile; every later read is a cheap browser
 * task in that profile ($0.005 per session + $0.0006 per step) that returns
 * the Experience section as JSON. Reads use the founder's LinkedIn identity,
 * so they are serialized, spaced and capped per day, and a login wall marks
 * the session invalid until a fresh cookie is pasted.
 *
 * Cached cross-workspace in the shared enrichment cache under
 * `linkedin-profile:<url>` (30 days; 3-day negative cache), the same way
 * `safeDeepResearchPerson` and the reply drafter's `webread:` reads are.
 */
import {
  browserTask,
  createBrowserProfile,
  ENRICH_FAILURE_TTL_MS,
  getLedger,
  isTransientToolError,
  listBrowserProfiles,
  loadConfig,
  logEvent,
  saveConfig,
  withDeadline,
  type CallContext,
} from "@oneshot-gtm/core";
import { isLinkedInProfileUrl } from "./_linkedin.ts";

export const LINKEDIN_PROFILE_NAME = "oneshot-gtm linkedin";
/** Upper bound for one read used by the budget checks; the SDK quote refuses anything past READ_MAX_COST_USD. */
export const LINKEDIN_READ_COST_ESTIMATE_USD = 0.02;
const READ_MAX_COST_USD = 0.05;
const READ_MAX_STEPS = 12;
const READ_TIMEOUT_SEC = 240;
const SEED_MAX_STEPS = 10;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Minimum gap between two reads from the same account. */
const READ_SPACING_MS = 15_000;
const CACHE_PREFIX = "linkedin-profile:";

export const LINKEDIN_EXPERIENCE_SCHEMA = {
  type: "object",
  properties: {
    loggedIn: { type: "boolean" },
    name: { type: ["string", "null"] },
    headline: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: ["string", "null"] },
          period: { type: ["string", "null"], description: "as shown, e.g. 'Mar 2026 - Present'" },
          location: { type: ["string", "null"] },
        },
        required: ["company"],
      },
    },
  },
  required: ["loggedIn", "experience"],
} as const;

export interface LiveExperience {
  company: string;
  title?: string;
  period?: string;
  location?: string;
}

export interface LiveProfile {
  url: string;
  readAt: string;
  name?: string;
  headline?: string;
  location?: string;
  experience: LiveExperience[];
}

export type LiveProfileSkip =
  | "not-linkedin"
  | "no-cookie"
  | "session-unchecked"
  | "session-invalid"
  | "daily-limit"
  | "cost-cap"
  | "failed";

export interface LiveProfileRead {
  profile: LiveProfile | null;
  skipped?: LiveProfileSkip;
  costUsd: number;
  cached: boolean;
}

export type LinkedInSessionState = "unset" | "unchecked" | "invalid" | "ok";

/** The founder's cookie, from the environment only; never persisted anywhere else. */
export function linkedinCookie(): string {
  return (process.env["LINKEDIN_SESSION_COOKIE"] ?? "").trim();
}

export function linkedinSessionState(cfg = loadConfig()): LinkedInSessionState {
  if (!linkedinCookie()) return "unset";
  if (cfg.linkedinSessionInvalidAt) return "invalid";
  if (!cfg.linkedinSessionCheckedAt || !cfg.linkedinBrowserProfileId) return "unchecked";
  return "ok";
}

export function linkedinProfileCacheKey(url: string): string {
  return `${CACHE_PREFIX}${normalizeProfileUrl(url)}`;
}

function normalizeProfileUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function startOfLocalDayIso(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Successful reads written today (local day), across workspaces. */
export function linkedInReadsToday(now = new Date()): number {
  try {
    return getLedger().countCachedEnrichmentSince(CACHE_PREFIX, startOfLocalDayIso(now));
  } catch {
    return 0;
  }
}

/**
 * The browser profile id to run in: the stored one when the platform still
 * has it, else an existing profile with our name (two workspaces on one
 * wallet share it), else a new one. Persists the id.
 */
export async function ensureLinkedInProfile(ctx: CallContext): Promise<string> {
  const cfg = loadConfig();
  const profiles = await listBrowserProfiles(ctx);
  const stored = cfg.linkedinBrowserProfileId
    ? profiles.find((p) => p.id === cfg.linkedinBrowserProfileId)
    : undefined;
  const byName = stored ?? profiles.find((p) => p.name === LINKEDIN_PROFILE_NAME);
  const profile = byName ?? (await createBrowserProfile(LINKEDIN_PROFILE_NAME, ctx));
  if (profile.id !== cfg.linkedinBrowserProfileId) {
    saveConfig({ ...cfg, linkedinBrowserProfileId: profile.id });
  }
  return profile.id;
}

export function markLinkedInSessionInvalid(reason: string): void {
  const cfg = loadConfig();
  saveConfig({ ...cfg, linkedinSessionInvalidAt: new Date().toISOString() });
  logEvent("linkedin_profile.session_invalid", { reason_120: reason.slice(0, 120) }, "warn");
}

function outputRecord(output: unknown): Record<string, unknown> {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // prose output: no structured fields
    }
  }
  return {};
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * One-time seeding: open linkedin.com in the profile, set the founder's
 * cookie in-page, reload, and report whether the member is signed in. The
 * cookie travels to the platform only as a task secret.
 */
export async function seedLinkedInSession(
  ctx: CallContext,
  opts: { cookie?: string } = {},
): Promise<{ loggedIn: boolean; name: string | null; profileId: string; costUsd: number }> {
  const cookie = opts.cookie ?? linkedinCookie();
  if (!cookie) throw new Error("LINKEDIN_SESSION_COOKIE is not set");
  const profileId = await ensureLinkedInProfile(ctx);
  const res = await browserTask(
    {
      task: [
        "You are on https://www.linkedin.com/ and NOT logged in.",
        "A secret for linkedin.com is provided in the form 'li_at:<value>'. Take the part after 'li_at:' as the cookie value.",
        "Set a cookie on this page using the browser's JavaScript console exactly like:",
        "document.cookie = 'li_at=<value>; domain=.linkedin.com; path=/; secure; SameSite=None';",
        "Then reload https://www.linkedin.com/feed/. Do not type into any login form and do not attempt to log in another way.",
        "Report loggedIn=true only if the page shows a personal feed or profile menu for a signed-in member, and name = the signed-in member's name if visible.",
        "Return JSON matching the schema.",
      ].join(" "),
      startUrl: "https://www.linkedin.com/",
      allowedDomains: ["linkedin.com", "www.linkedin.com"],
      profileId,
      secrets: { "linkedin.com": `li_at:${cookie}` },
      outputSchema: {
        type: "object",
        properties: { loggedIn: { type: "boolean" }, name: { type: ["string", "null"] } },
        required: ["loggedIn"],
      },
      maxSteps: SEED_MAX_STEPS,
      maxCost: 0.1,
      timeoutSec: READ_TIMEOUT_SEC,
    },
    { ...ctx, memo: ctx.memo ?? "linkedin: seed the browser profile session" },
  );
  const out = outputRecord(res.result.output);
  const loggedIn = out["loggedIn"] === true;
  const name = str(out, "name") ?? null;
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    linkedinBrowserProfileId: profileId,
    linkedinSessionCheckedAt: new Date().toISOString(),
    linkedinSessionName: loggedIn ? name : null,
    linkedinSessionInvalidAt: loggedIn ? null : new Date().toISOString(),
  });
  logEvent("linkedin_profile.session_seeded", { logged_in: loggedIn });
  return { loggedIn, name, profileId, costUsd: res.result.cost ?? 0 };
}

// One read at a time from the founder's account, with a gap between reads.
let readChain: Promise<unknown> = Promise.resolve();
let lastReadStartedAt = 0;

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = readChain.then(async () => {
    const wait = lastReadStartedAt + READ_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReadStartedAt = Date.now();
    return fn();
  });
  readChain = run.catch(() => undefined);
  return run;
}

/**
 * Read one profile's Experience section. Cache first; every skip has a
 * reason the caller can put in the dossier's warning.
 */
export async function readLinkedInProfile(
  url: string,
  ctx: CallContext,
  opts: { remainingUsd: number; now?: Date },
): Promise<LiveProfileRead> {
  if (!isLinkedInProfileUrl(url))
    return { profile: null, skipped: "not-linkedin", costUsd: 0, cached: false };
  const ledger = getLedger();
  const key = linkedinProfileCacheKey(url);
  const now = opts.now ?? new Date();
  let cached: ReturnType<typeof ledger.getCachedEnrichment> = null;
  try {
    cached = ledger.getCachedEnrichment(key);
  } catch {
    // a cache read failure is a miss
  }
  if (cached) {
    const age = now.getTime() - new Date(cached.fetched_at).getTime();
    if (cached.status === "failed") {
      if (age < ENRICH_FAILURE_TTL_MS)
        return { profile: null, skipped: "failed", costUsd: 0, cached: true };
    } else if (age < CACHE_TTL_MS) {
      try {
        return { profile: JSON.parse(cached.result_json) as LiveProfile, costUsd: 0, cached: true };
      } catch {
        // corrupt row → refetch
      }
    }
  }
  const cfg = loadConfig();
  const state = linkedinSessionState(cfg);
  if (state === "unset") return { profile: null, skipped: "no-cookie", costUsd: 0, cached: false };
  if (state === "invalid")
    return { profile: null, skipped: "session-invalid", costUsd: 0, cached: false };
  if (state === "unchecked")
    return { profile: null, skipped: "session-unchecked", costUsd: 0, cached: false };
  if (linkedInReadsToday(now) >= (cfg.linkedinReadsPerDay ?? 80)) {
    return { profile: null, skipped: "daily-limit", costUsd: 0, cached: false };
  }
  if (opts.remainingUsd < LINKEDIN_READ_COST_ESTIMATE_USD) {
    return { profile: null, skipped: "cost-cap", costUsd: 0, cached: false };
  }
  const profileId = cfg.linkedinBrowserProfileId!;
  return serialized(async () => {
    // Re-check inside the gate: an earlier read in the queue may have hit the
    // limit or invalidated the session.
    if (linkedinSessionState() !== "ok") {
      return { profile: null, skipped: "session-invalid", costUsd: 0, cached: false };
    }
    if (linkedInReadsToday(new Date()) >= (loadConfig().linkedinReadsPerDay ?? 80)) {
      return { profile: null, skipped: "daily-limit", costUsd: 0, cached: false };
    }
    try {
      const res = await withDeadline(
        browserTask(
          {
            task: [
              `Open ${url}. If the page asks you to sign in or join, set loggedIn=false and return an empty experience list; do not attempt to log in.`,
              "Otherwise read the Experience section (click 'Show all experiences' if present) and return every position as {company, title, period, location}, with period exactly as shown (e.g. 'Mar 2026 - Present').",
              "Also return name, headline and location from the top of the profile. Return JSON matching the schema.",
            ].join(" "),
            startUrl: url,
            allowedDomains: ["linkedin.com", "www.linkedin.com"],
            profileId,
            outputSchema: LINKEDIN_EXPERIENCE_SCHEMA as unknown as Record<string, unknown>,
            maxSteps: READ_MAX_STEPS,
            maxCost: READ_MAX_COST_USD,
            timeoutSec: READ_TIMEOUT_SEC,
          },
          { ...ctx, memo: ctx.memo ?? "linkedin: read the profile's experience section" },
        ),
        READ_TIMEOUT_SEC * 1000 + 30_000,
        "linkedin profile read",
      );
      const costUsd = res.result.cost ?? 0;
      const out = outputRecord(res.result.output);
      const wall = (res.result.steps ?? []).some((s) =>
        /linkedin\.com\/(?:login|authwall|checkpoint|uas\/login)/i.test(s.url ?? ""),
      );
      if (out["loggedIn"] === false || wall) {
        markLinkedInSessionInvalid(
          wall ? "login wall during read" : "read reported loggedIn=false",
        );
        return { profile: null, skipped: "session-invalid", costUsd, cached: false };
      }
      const experience = (Array.isArray(out["experience"]) ? out["experience"] : [])
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
        .map((e) => {
          const item: LiveExperience = { company: str(e, "company") ?? "" };
          const title = str(e, "title");
          const period = str(e, "period");
          const location = str(e, "location");
          if (title) item.title = title;
          if (period) item.period = period;
          if (location) item.location = location;
          return item;
        })
        .filter((e) => e.company);
      const profile: LiveProfile = {
        url,
        readAt: new Date().toISOString(),
        ...(str(out, "name") ? { name: str(out, "name")! } : {}),
        ...(str(out, "headline") ? { headline: str(out, "headline")! } : {}),
        ...(str(out, "location") ? { location: str(out, "location")! } : {}),
        experience,
      };
      try {
        ledger.setCachedEnrichment(key, JSON.stringify(profile));
      } catch {
        // cache write is best-effort
      }
      logEvent("linkedin_profile.read", { positions: experience.length, cost_usd: costUsd });
      return { profile, costUsd, cached: false };
    } catch (err) {
      const message = (err as Error).message ?? "";
      logEvent(
        "linkedin_profile.read_failed",
        { message_120: message.slice(0, 120), transient: isTransientToolError(err) },
        "warn",
      );
      if (!isTransientToolError(err)) {
        try {
          ledger.setCachedEnrichmentFailure(key, message || "linkedin read failed");
        } catch {
          // best-effort
        }
      }
      return { profile: null, skipped: "failed", costUsd: 0, cached: false };
    }
  });
}

/** Test hook: reset the serialization gate. */
export function _resetLinkedInReadGate(): void {
  readChain = Promise.resolve();
  lastReadStartedAt = 0;
}
