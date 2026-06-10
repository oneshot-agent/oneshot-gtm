import { getLedger, logEvent, startRun } from "@oneshot-gtm/core";
import { type CohortEntry, runAcceleratorBatchFinder } from "./accelerator-batch.ts";
import { deriveCohortLabel } from "./_yc-oss-adapter.ts";
import { runBreakupReviveFinder } from "./breakup-revive.ts";
import { type RepoWatch, runGitHubStarsFinder } from "./github-stars.ts";
import { runGitHubTopicsFinder } from "./github-topics.ts";
import { runHiringSignalFinder } from "./hiring-signal.ts";
import { runJobChangeFinder } from "./job-change.ts";
import { runLumaFinder } from "./luma.ts";
import { runPodcastGuestFinder } from "./podcast-guest.ts";
import { runPostFundingFinder } from "./post-funding.ts";
import { runShowHnFinder } from "./show-hn.ts";
import type { FinderResult } from "./_types.ts";

export interface TriggerSpec {
  name: string;
  defaultIntervalMs: number;
  defaultConfig: Record<string, unknown>;
  /** Whether new installs auto-enable this trigger. Default true. */
  enabledByDefault?: boolean;
  /**
   * Plain-English brief the strategist embeds in its system prompt. Describes
   * what the finder does + what each config key controls. Founder-facing too:
   * the chat references these so the founder doesn't have to know JSON shapes.
   */
  configBrief?: string;
  /**
   * Optional readiness gate. Return `{ready:false, reason}` when the stored
   * config lacks required founder-supplied inputs (e.g. github-topics without
   * `topics`). Consulted by the server's enable/run endpoints and by the watch
   * loop to avoid pointless runs. When absent, the trigger is always ready.
   */
  readiness?: (
    config: Record<string, unknown>,
  ) => { ready: true } | { ready: false; reason: string };
  run: (config: Record<string, unknown>) => Promise<FinderResult>;
}

export type Readiness = { ready: true } | { ready: false; reason: string };

/** Evaluate a spec's readiness fn (defaulting to ready when absent). */
export function checkReadiness(spec: TriggerSpec, config: Record<string, unknown>): Readiness {
  if (!spec.readiness) return { ready: true };
  try {
    return spec.readiness(config);
  } catch {
    // A throwing readiness fn shouldn't bring down the watch loop; treat as
    // not-ready with a generic reason so the founder sees *something*.
    return { ready: false, reason: "readiness check threw" };
  }
}

const ONE_HOUR = 3600 * 1000;

/**
 * Default cohort sweep for the `accelerator-batch` trigger. Covers seven
 * incubators × {latest, previous-latest} cohorts as of 2026-05-20. Only the
 * yc-* entries hit the structured yc-oss/api directory; the other 12 route
 * to the websearch + LLM-extract adapter and will have spotty per-cohort
 * recall (Neo is invite-only, SPC publishes thin web footprint, etc.).
 * Per-cohort failures are isolated — the run only halts when EVERY cohort
 * comes back empty.
 *
 * ROTATION: this list goes stale within ~3 months as YC announces W27,
 * Techstars rolls Fall 2026, etc. Founders should edit `cohorts[]` via the
 * trigger config UI on /queue when new batches announce.
 */
const DEFAULT_COHORTS: CohortEntry[] = [
  { cohort: "yc-w26", cohortLabel: "YC W26" },
  { cohort: "yc-f25", cohortLabel: "YC F25" },
  { cohort: "techstars-spring-2026", cohortLabel: "Techstars Spring 2026" },
  { cohort: "techstars-fall-2025", cohortLabel: "Techstars Fall 2025" },
  { cohort: "antler-q1-2026", cohortLabel: "Antler Q1 2026" },
  { cohort: "antler-q4-2025", cohortLabel: "Antler Q4 2025" },
  { cohort: "500global-batch-38", cohortLabel: "500 Global Batch 38" },
  { cohort: "500global-batch-37", cohortLabel: "500 Global Batch 37" },
  { cohort: "ai-grant-cohort-5", cohortLabel: "AI Grant Cohort 5" },
  { cohort: "ai-grant-cohort-4", cohortLabel: "AI Grant Cohort 4" },
  { cohort: "spc-2026-1", cohortLabel: "South Park Commons F1 2026-1" },
  { cohort: "spc-2025-2", cohortLabel: "South Park Commons F1 2025-2" },
  { cohort: "neo-class-2026", cohortLabel: "Neo Class 2026" },
  { cohort: "neo-class-2025", cohortLabel: "Neo Class 2025" },
];

export const TRIGGERS: TriggerSpec[] = [
  {
    name: "show-hn",
    defaultIntervalMs: 6 * ONE_HOUR,
    defaultConfig: { sinceDays: 1, limit: 25, maxCostUsd: 5 },
    configBrief:
      "Polls Hacker News Algolia for recent Show HN posts, ICP-filters them, enriches founder contact, and enqueues them for review. Config: `sinceDays` (lookback window, default 1), `limit` (max kept, default 25), `maxCostUsd` (per-run spend cap). Defaults work for most ICPs — bump sinceDays to 7+ if your ICP is niche enough that daily volume is thin.",
    run: (cfg) =>
      runShowHnFinder({
        dryRun: false,
        sinceDays: (cfg["sinceDays"] as number) ?? 1,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    name: "accelerator-batch",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    // Default sweep: every known incubator × {latest, previous-latest} cohorts.
    // Founders can trim or edit the list in /queue → trigger config; per-cohort
    // failures don't halt the run, so spotty incubators (Neo, SPC) coexist
    // with high-recall ones (YC, Techstars) in one trigger fire.
    defaultConfig: {
      cohorts: DEFAULT_COHORTS,
      limit: 25,
      maxCostUsd: 15,
    },
    configBrief:
      "Sweeps every known incubator (YC, Techstars, Antler, 500 Global, AI Grant, SPC, Neo) at its latest + previous-latest cohorts in one run. Config: `cohorts` (array of `{cohort, cohortLabel}` — defaults to the 14-entry curated list; edit to add/remove batches as new cohorts announce), optional `cohort` + `cohortLabel` (legacy single-cohort shape; still accepted), optional `adapter` (`yc-oss` | `websearch`; auto-picked per cohort — yc-* tags use the free yc-oss/api directory, everything else falls back to web search), `senderCohort` (YOUR own cohort tag, e.g. `yc-w23` — the peer angle the email is built on; REQUIRED, stamped onto every enqueued row so rows draft inline), `freeForCohortOffer` (optional time-bound offer, also stamped onto rows), `limit` (global enqueue cap across all cohorts), `maxCostUsd`. Per-cohort failures (spotty incubator, network blip) log and continue; the run only halts when EVERY cohort returns 0 candidates. ROTATION: the default list goes stale within ~3 months — edit when YC announces W27, Techstars rolls Fall 2026, etc. STRATEGIST DUTY: when the founder's ICP overlaps strongly with one incubator population, narrow the cohorts list rather than sweeping all seven — e.g. AI/infra startups → keep yc-* + ai-grant-*, drop the rest.",
    readiness: (cfg) => {
      const cohorts = Array.isArray(cfg["cohorts"]) ? cfg["cohorts"] : null;
      const legacyCohort =
        typeof cfg["cohort"] === "string" ? (cfg["cohort"] as string).trim() : "";
      if ((!cohorts || cohorts.length === 0) && legacyCohort.length === 0) {
        return {
          ready: false,
          reason: "set `cohorts[]` (or legacy `cohort`)",
        };
      }
      const senderCohort =
        typeof cfg["senderCohort"] === "string" ? (cfg["senderCohort"] as string).trim() : "";
      if (senderCohort.length === 0) {
        return {
          ready: false,
          reason: "set `senderCohort` (your own cohort tag, e.g. yc-w23)",
        };
      }
      return { ready: true };
    },
    run: (cfg) => {
      // Multi-cohort path: new `cohorts` array wins. Filter to well-formed
      // entries so a single malformed row doesn't kill the run.
      const cohortsRaw = Array.isArray(cfg["cohorts"]) ? (cfg["cohorts"] as unknown[]) : [];
      const cohorts: CohortEntry[] = cohortsRaw
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const e = entry as Record<string, unknown>;
          const cohort = typeof e["cohort"] === "string" ? e["cohort"].trim() : "";
          if (cohort.length === 0) return null;
          const labelRaw =
            typeof e["cohortLabel"] === "string" ? (e["cohortLabel"] as string).trim() : "";
          const cohortLabel = labelRaw.length > 0 ? labelRaw : deriveCohortLabel(cohort);
          return { cohort, cohortLabel };
        })
        .filter((e): e is CohortEntry => e !== null);

      // Legacy single-cohort path: only used when `cohorts` is empty/missing.
      const legacyCohort = typeof cfg["cohort"] === "string" ? (cfg["cohort"] as string) : "";
      const legacyLabel =
        typeof cfg["cohortLabel"] === "string" ? (cfg["cohortLabel"] as string) : "";

      return runAcceleratorBatchFinder({
        dryRun: false,
        ...(cohorts.length > 0 ? { cohorts } : {}),
        ...(cohorts.length === 0 && legacyCohort.trim().length > 0
          ? { cohort: legacyCohort, cohortLabel: legacyLabel }
          : {}),
        ...(cfg["adapter"] === "yc-oss" || cfg["adapter"] === "websearch"
          ? { adapter: cfg["adapter"] as "yc-oss" | "websearch" }
          : {}),
        // Sender cohort (+ offer) stamped onto every enqueued row so the play
        // drafts inline without a run-level value. Readiness gates senderCohort.
        ...(typeof cfg["senderCohort"] === "string" && cfg["senderCohort"].trim().length > 0
          ? { senderCohort: (cfg["senderCohort"] as string).trim() }
          : {}),
        ...(typeof cfg["freeForCohortOffer"] === "string" &&
        cfg["freeForCohortOffer"].trim().length > 0
          ? { freeForCohortOffer: (cfg["freeForCohortOffer"] as string).trim() }
          : {}),
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 15,
      });
    },
  },
  {
    name: "post-funding-auto",
    defaultIntervalMs: 12 * ONE_HOUR,
    defaultConfig: {
      autoRounds: ["Seed", "Series A"],
      autoSinceDays: 7,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Auto-discovers funding announcements via webSearch, extracts company + founder, ICP-filters. Config: `autoRounds` (e.g. ['Seed','Series A','Series B'] — match what your ICP actually buys at), `autoIndustry` (optional industry hint to bias the search query — derive from the ICP), `autoSinceDays` (lookback, default 7), `limit`, `maxCostUsd`. Tune autoRounds to skip stages that won't buy yet.",
    run: (cfg) =>
      runPostFundingFinder({
        dryRun: false,
        auto: true,
        autoRounds: (cfg["autoRounds"] as string[]) ?? ["Seed", "Series A"],
        ...(typeof cfg["autoIndustry"] === "string"
          ? { autoIndustry: cfg["autoIndustry"] as string }
          : {}),
        autoSinceDays: (cfg["autoSinceDays"] as number) ?? 7,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  // Opt-in: these finders need founder-supplied personas/roles/podcasts to be
  // useful, so they ship disabled. Enable from /queue → Triggers.
  {
    name: "job-change",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      personas: ["VP Engineering", "Head of Growth", "Director of Product", "Chief of Staff"],
      sinceDays: 14,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Searches for 'joined X as Y' job-change announcements, ICP-filters, enriches the new email. Config: `personas` (the roles whose JOB CHANGE represents a buying moment for THIS product — not generic 'VP Eng' unless that's actually who buys; e.g. 'Head of AI', 'Founding Engineer' for AI-tooling ICPs), `companies` (optional whitelist of companies to bias toward), `sinceDays` (lookback, default 14), `limit`, `maxCostUsd`. Strong personas matter more than long lists.",
    run: (cfg) =>
      runJobChangeFinder({
        dryRun: false,
        ...(Array.isArray(cfg["personas"]) ? { personas: cfg["personas"] as string[] } : {}),
        ...(Array.isArray(cfg["companies"]) ? { companies: cfg["companies"] as string[] } : {}),
        sinceDays: (cfg["sinceDays"] as number) ?? 14,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    name: "hiring-signal",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      roles: ["Staff Engineer", "ML Engineer", "Solutions Engineer"],
      sinceDays: 14,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Scans Greenhouse / Lever / Workable / Ashby ATS pages for open roles that signal the company would buy THIS product. Config: `roles` (job titles whose existence implies a need for the product — e.g. 'Founding ML Engineer' for AI-infra products, 'Head of Compliance' for compliance products), `companies` (optional whitelist), `yourClaim` (one-sentence pitch about why your product makes that role's first 90 days easier — fed into the email; REQUIRED), `sinceDays`, `limit`, `maxCostUsd`. The roles + yourClaim need to be tightly coupled to the product.",
    readiness: (cfg) => {
      const claim = typeof cfg["yourClaim"] === "string" ? (cfg["yourClaim"] as string).trim() : "";
      return claim.length > 0
        ? { ready: true }
        : { ready: false, reason: "set `yourClaim` (your one-line pitch)" };
    },
    run: (cfg) =>
      runHiringSignalFinder({
        dryRun: false,
        ...(Array.isArray(cfg["roles"]) ? { roles: cfg["roles"] as string[] } : {}),
        ...(Array.isArray(cfg["companies"]) ? { companies: cfg["companies"] as string[] } : {}),
        ...(typeof cfg["yourClaim"] === "string" ? { yourClaim: cfg["yourClaim"] as string } : {}),
        sinceDays: (cfg["sinceDays"] as number) ?? 14,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    name: "podcast-guest",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      podcasts: ["Latent Space", "Lenny's Podcast", "20VC", "Acquired", "Invest Like the Best"],
      sinceDays: 21,
      skipRead: false,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Discovers recent podcast guests, ICP-filters, enriches their email. Config: `podcasts` (shows whose guest demographic overlaps with the ICP — replace defaults with shows the founder's actual buyer listens to), `sinceDays` (default 21), `skipRead` (skip per-episode webRead for cheaper but less accurate runs), `limit`, `maxCostUsd`. Podcast list is the leverage — narrow + on-target beats broad.",
    run: (cfg) =>
      runPodcastGuestFinder({
        dryRun: false,
        ...(Array.isArray(cfg["podcasts"]) ? { podcasts: cfg["podcasts"] as string[] } : {}),
        sinceDays: (cfg["sinceDays"] as number) ?? 21,
        skipRead: cfg["skipRead"] === true,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    // Luma upcoming-event hosts + featured guests. Discovery reads Luma's
    // per-city pages (genuinely upcoming; webSearch fallback for unmapped
    // cities); each event passes a keyword + LLM topic/ICP gate before any
    // paid read; attendees come structured (with linkedin/website) from
    // Luma's public event JSON. Contact via LinkedIn enrichProfile or
    // website domain, then the standard findEmail chain.
    name: "luma-events",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      topics: ["AI", "founders"] as string[],
      cities: ["San Francisco", "New York"] as string[],
      sinceDays: 14,
      yourEdge: "",
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Discovers upcoming Luma events from Luma's per-city pages, gates each event on the founder's topics + ICP (a free keyword pre-filter, then one LLM relevance call on the event name) BEFORE any paid read, then pitches the event's hosts + featured guests — Luma's public event JSON carries their LinkedIn/website, so contact resolution lands. Coverage per event: the hosts (always public) + up to ~10 featured guests when the organizer shows 'Who's Coming'. Each row is tagged Host or Guest and the email is drafted role-aware. Config: `topics` (phrases whose words must appear in / relate to the event name — e.g. ['AI agents', 'MCP']; they gate events, not search queries), `cities` (major hubs work best — San Francisco, New York, LA, London, etc. map to Luma city pages; other cities fall back to webSearch), `yourEdge` (one-line angle on why your product helps event-going people, REQUIRED), `sinceDays` (forward-looking window in days — events further out than this are dropped), `limit`, `maxCostUsd`. STRATEGIST DUTY: align topics to your ICP's actual gathering spots (AI hackers ≠ growth marketers) and include the vocabulary event names actually use (e.g. 'agents', 'hackathon', 'MCP').",
    readiness: (cfg) => {
      const topics = Array.isArray(cfg["topics"]) ? cfg["topics"] : null;
      if (!topics || topics.filter((t) => typeof t === "string" && t.trim()).length === 0) {
        return { ready: false, reason: "set `topics` (e.g. ['AI','founders'])" };
      }
      const cities = Array.isArray(cfg["cities"]) ? cfg["cities"] : null;
      if (!cities || cities.filter((c) => typeof c === "string" && c.trim()).length === 0) {
        return { ready: false, reason: "set `cities` (e.g. ['San Francisco'])" };
      }
      const edge = cfg["yourEdge"];
      if (typeof edge !== "string" || edge.trim().length === 0) {
        return { ready: false, reason: "set `yourEdge` — one-line pitch for event attendees" };
      }
      return { ready: true };
    },
    run: (cfg) =>
      runLumaFinder({
        dryRun: false,
        ...(Array.isArray(cfg["topics"])
          ? {
              topics: (cfg["topics"] as unknown[]).filter(
                (t): t is string => typeof t === "string",
              ),
            }
          : {}),
        ...(Array.isArray(cfg["cities"])
          ? {
              cities: (cfg["cities"] as unknown[]).filter(
                (c): c is string => typeof c === "string",
              ),
            }
          : {}),
        ...(typeof cfg["yourEdge"] === "string" ? { yourEdge: cfg["yourEdge"] as string } : {}),
        sinceDays: (cfg["sinceDays"] as number) ?? 14,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    // GitHub-Topic-driven repo finder. Discovers via the (free) GitHub Search
    // API filtered by `topic:<slug>` — topic-tagged repos are pre-curated by
    // maintainers self-tagging, much higher signal-per-fetch than the
    // retired combo-search approach. Feeds stack-consolidation (vendor-
    // sprawl pitch) by default, or competitor-switch when a detected vendor
    // is on `directCompetitors`. Config-driven — the founder supplies topics
    // + vendors + edge via /queue; ships empty so nothing fires until configured.
    name: "github-topics",
    defaultIntervalMs: 12 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      topics: [] as string[],
      vendors: [] as string[],
      directCompetitors: [] as string[],
      yourEdge: "",
      minStars: 5,
      maxAgeDays: 90,
      minVendors: 1,
      concurrency: 3,
      useDeepResearch: true,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Discovers repos via GitHub Topic pages (`topic:<slug>` queries on the GitHub Search API), then scans each candidate's package.json / pyproject.toml / requirements.txt / .env.example via the GitHub Contents API to detect which API vendors the repo actually uses. Routes each candidate to one of two motion plays: stack-consolidation (default — pitch collapsing the vendor sprawl into one SDK) or competitor-switch (when a detected vendor is on `directCompetitors` — a head-on 'switch from X' pitch). Required config: `topics` (GitHub topic slugs the founder's ICP overlaps with — lowercase, hyphenated, EXACT GitHub-canonical form; singular vs plural matters), `vendors` (the founder's competitive landscape — the API vendors they aim to replace), `yourEdge` (one-sentence pitch handed to the email). Optional `directCompetitors`: a subset of `vendors` the founder competes with head-on (same canonical spelling, matched case-insensitively); a candidate using one routes to competitor-switch instead of stack-consolidation. Empty by default, so every candidate is stack-consolidation until set. VOCAB SEMANTICS: each `vendors` string is substring-matched (case-insensitive) against manifest deps + env-var keys — so `twilio` matches `twilio`, `twilio-node`, `@twilio/voice-sdk`, AND `TWILIO_ACCOUNT_SID`. There is NO hardcoded vendor list; oneshot-gtm is a generic founder tool and competitive vocabularies vary entirely by founder. STRATEGIST DUTY: when you (the strategist) have enough context about the founder's product/ICP, proactively propose BOTH `topics` AND `vendors` via apply-config — topics are GitHub category slugs aligned to ICP; vendors are the API competitors the founder replaces. The founder shouldn't have to enumerate either by hand. Other config: `minStars` (filter, default 5), `maxAgeDays` (default 90), `minVendors` (gate: how many distinct vocab vendors must match in a candidate's manifests; default 1), `concurrency` (in-flight workers; default 3), `useDeepResearch` (default true), `limit`, `maxCostUsd`.",
    readiness: (cfg) => {
      const topics = cfg["topics"];
      if (!Array.isArray(topics) || topics.length === 0) {
        return {
          ready: false,
          reason: "set `topics` (one or more GitHub topic slugs, e.g. 'llm-agents')",
        };
      }
      const vendors = cfg["vendors"];
      if (!Array.isArray(vendors) || vendors.length === 0) {
        return {
          ready: false,
          reason: "set `vendors` — your competitive landscape (ask the strategist to propose one)",
        };
      }
      const edge = cfg["yourEdge"];
      if (typeof edge !== "string" || edge.trim().length === 0) {
        return {
          ready: false,
          reason: "set `yourEdge` — one-sentence consolidation pitch",
        };
      }
      return { ready: true };
    },
    run: (cfg) => {
      const topics = Array.isArray(cfg["topics"])
        ? (cfg["topics"] as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      const vendors = Array.isArray(cfg["vendors"])
        ? (cfg["vendors"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const directCompetitors = Array.isArray(cfg["directCompetitors"])
        ? (cfg["directCompetitors"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const yourEdge = typeof cfg["yourEdge"] === "string" ? cfg["yourEdge"] : "";
      return runGitHubTopicsFinder({
        dryRun: false,
        topics,
        vendors,
        directCompetitors,
        yourEdge,
        minStars: (cfg["minStars"] as number) ?? 5,
        maxAgeDays: (cfg["maxAgeDays"] as number) ?? 90,
        minVendors: (cfg["minVendors"] as number) ?? 2,
        concurrency: (cfg["concurrency"] as number) ?? 3,
        useDeepResearch: cfg["useDeepResearch"] !== false,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      });
    },
  },
  {
    name: "github-stars",
    defaultIntervalMs: 12 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      repos: [] as Array<{ repo: string; rel: string; label?: string; repoEdge?: string }>,
      yourEdge: "",
      sinceDays: 30,
      concurrency: 3,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      'Finds recent stargazers of repos you watch and turns them into prospects. Config: `repos` (array of `{repo:"owner/name", rel:"competitor"|"adjacent", label?, repoEdge?}` — tag a repo `competitor` to pitch a switch (→ competitor-switch) or `adjacent` for a complementary intro (→ repo-interest); `label` is the human name, else derived from the repo; `repoEdge` is an OPTIONAL per-repo line on why THAT repo is notable + the respectful bridge to your offer, used by repo-interest as a shared-taste nod that also shapes the pitch — e.g. a privacy-first repo leads with control/auditability, not "we do it for you"), `yourEdge` (one-line pitch fed to whichever play, REQUIRED), `sinceDays` (recency window, default 30), `limit`, `maxCostUsd`. Needs `GITHUB_TOKEN` for any volume. STRATEGIST DUTY: pick repos your buyers\' current tools live in; tag the ones you replace as `competitor`, the rest `adjacent`; give each adjacent repo a `repoEdge` so the intro nods to why they chose THAT tool.',
    readiness: (cfg) => {
      const repos = Array.isArray(cfg["repos"]) ? cfg["repos"] : [];
      const valid = repos.filter((r) => {
        if (!r || typeof r !== "object") return false;
        const e = r as Record<string, unknown>;
        return (
          typeof e["repo"] === "string" &&
          e["repo"].trim().length > 0 &&
          (e["rel"] === "competitor" || e["rel"] === "adjacent")
        );
      });
      if (valid.length === 0) {
        return {
          ready: false,
          reason: "set `repos` (each `{repo, rel:'competitor'|'adjacent'}`)",
        };
      }
      const edge = cfg["yourEdge"];
      if (typeof edge !== "string" || edge.trim().length === 0) {
        return { ready: false, reason: "set `yourEdge` — your one-line pitch" };
      }
      return { ready: true };
    },
    run: (cfg) => {
      const repos: RepoWatch[] = (Array.isArray(cfg["repos"]) ? cfg["repos"] : [])
        .map((r): RepoWatch | null => {
          if (!r || typeof r !== "object") return null;
          const e = r as Record<string, unknown>;
          const repo = typeof e["repo"] === "string" ? e["repo"].trim() : "";
          const rel = e["rel"];
          if (repo.length === 0 || (rel !== "competitor" && rel !== "adjacent")) return null;
          const label = typeof e["label"] === "string" ? e["label"].trim() : "";
          const repoEdge = typeof e["repoEdge"] === "string" ? e["repoEdge"].trim() : "";
          const watch: RepoWatch = { repo, rel };
          if (label) watch.label = label;
          if (repoEdge) watch.repoEdge = repoEdge;
          return watch;
        })
        .filter((r): r is RepoWatch => r !== null);
      return runGitHubStarsFinder({
        dryRun: false,
        repos,
        yourEdge: typeof cfg["yourEdge"] === "string" ? cfg["yourEdge"] : "",
        sinceDays: (cfg["sinceDays"] as number) ?? 30,
        concurrency: (cfg["concurrency"] as number) ?? 3,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      });
    },
  },
  {
    // Ledger-only finder; no OneShot/LLM spend. Opt-in so it doesn't surprise
    // founders on fresh installs where the ledger is mostly empty.
    name: "breakup-revive",
    defaultIntervalMs: 7 * 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: { minDays: 60, maxDays: 90, limit: 25 },
    configBrief:
      "Scans the founder's local prospect ledger for cold leads (no reply, marketable) within the day window and re-enqueues them for a pattern-interrupt revive. No agent/LLM spend (ledger-only). Config: `minDays` / `maxDays` (the cold-window — defaults 60-90), `limit`. Only enable when the founder has been sending for ≥2 months — empty ledger = no revives.",
    run: async (cfg) =>
      runBreakupReviveFinder({
        dryRun: false,
        minDays: (cfg["minDays"] as number) ?? 60,
        maxDays: (cfg["maxDays"] as number) ?? 90,
        limit: (cfg["limit"] as number) ?? 25,
      }),
  },
];

/**
 * Resolve the active interval for a trigger: stored config_json may override
 * the registry's defaultIntervalMs via `intervalMs`. This keeps the JSON-config
 * editor in /queue meaningful — bumping it from 24h → 6h actually changes the
 * watch loop's cadence.
 */
export function effectiveIntervalMs(
  spec: TriggerSpec,
  config: Record<string, unknown> | null,
): number {
  const override = config?.["intervalMs"];
  if (typeof override === "number" && Number.isFinite(override) && override >= 60_000) {
    return Math.floor(override);
  }
  return spec.defaultIntervalMs;
}

export interface TriggerRunOutcome {
  name: string;
  fired: boolean;
  result?: FinderResult;
  error?: string;
  /** ms until this trigger is next due */
  nextDueInMs: number;
}

/**
 * Maximum age before an in-flight `running_started_at` is considered a
 * killed-by-restart zombie and swept by `sweepStaleRunningTriggers`.
 *
 * Real finder runtimes are dominated by the per-candidate pipeline (icpFilter
 * LLM + findEmail + verifyEmail, occasionally + webRead + deepResearchPerson).
 * github-topics with concurrency=3 typically completes 25 candidates in
 * 5-15 min; the deepResearchPerson tier (2-5 min async per call) sets the
 * realistic upper bound when many candidates fall into the hard-recovery bucket.
 *
 * 4h is set with generous headroom so a genuinely-running finder is never
 * mistakenly classified as zombie. If a run actually exceeds this, the
 * sweep marks it killed and `markTriggerRunning` lets a follow-up click
 * re-claim — bounded duplicate spend is preferable to the permanently-
 * stuck 409 state.
 */
export const MAX_RUN_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * Truth of "is this trigger running" lives in the ledger
 * (`triggers.running_started_at`). Survives server restart so the UI shows
 * accurate state across `bun --watch` re-execs and OS reboots.
 *
 * The freshness gate (`< MAX_RUN_AGE_MS`) hides stale rows that the boot
 * sweep hasn't cleaned up yet — defense in depth so we never report "still
 * running" for a row that's older than any real run could be.
 */
/**
 * Pure helper extracted so the freshness gate is unit-testable without
 * mocking the ledger. Returns the parsed start-epoch when the iso
 * timestamp is valid AND fresh (within MAX_RUN_AGE_MS of `now`); null
 * otherwise.
 *
 * `nowMs` is injected so tests can drive time without faking Date.
 */
export function freshRunningStartedAtMs(
  iso: string | null | undefined,
  nowMs: number,
): number | null {
  if (!iso) return null;
  const startedMs = new Date(iso).getTime();
  if (!Number.isFinite(startedMs)) return null;
  if (nowMs - startedMs > MAX_RUN_AGE_MS) return null;
  return startedMs;
}

export function isTriggerRunning(name: string): boolean {
  return getTriggerRunningSince(name) !== null;
}

export function getTriggerRunningSince(name: string): number | null {
  return freshRunningStartedAtMs(getLedger().getTrigger(name)?.running_started_at, Date.now());
}

/**
 * Fire-and-forget wrapper around `runTriggerNow`: returns immediately after
 * marking the trigger as running in the ledger; the actual finder work runs
 * on the event loop. Throws synchronously if the trigger is unknown,
 * already running, or unready.
 *
 * Errors from the finder are swallowed here — `runTriggerNow` already
 * persists them to the ledger (`last_run_summary`) and emits a
 * `trigger.run.error` event, so there's nothing useful for the caller to do.
 *
 * If the process is killed mid-run (bun --watch re-exec, OS reboot), the
 * row's `running_started_at` stays set. The next cold boot's
 * `sweepStaleRunningTriggers` call writes a `killed_by_restart` summary so
 * the UI shows the truth instead of frozen-from-an-hour-ago state.
 */
export function fireTriggerNow(name: string): void {
  const spec = TRIGGERS.find((t) => t.name === name);
  if (!spec) {
    throw new Error(`unknown trigger '${name}'`);
  }
  const ledger = getLedger();
  // Readiness gate: block the run synchronously so the server route can map
  // this to a 409 without the finder ever being invoked on a dead config.
  const stored = ledger.getTrigger(name);
  const config = stored?.config_json
    ? (JSON.parse(stored.config_json) as Record<string, unknown>)
    : spec.defaultConfig;
  const readiness = checkReadiness(spec, config);
  if (!readiness.ready) {
    throw new Error(`not ready: ${readiness.reason}`);
  }
  // Bootstrap the row if it doesn't exist yet — markTriggerRunning is an
  // UPDATE that no-ops on a missing row, so we'd silently lose state.
  if (!stored) {
    ledger.upsertTrigger({
      name,
      configJson: JSON.stringify(spec.defaultConfig),
      enabled: spec.enabledByDefault !== false,
    });
  }
  // Atomic claim — no TOCTOU race. Two concurrent fires both calling
  // markTriggerRunning will see exactly one `true` and one `false`, so
  // only one finder run actually launches.
  //
  // The `staleCutoffIso` lets a fresh click reclaim a row whose previous
  // `running_started_at` is older than `MAX_RUN_AGE_MS` — i.e. the freshness
  // gate already says "not running" but the DB flag never got cleared
  // (process killed, no cold-boot sweep yet). Without this the user would
  // see Run-button-enabled, click, and get 409'd every retry.
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - MAX_RUN_AGE_MS).toISOString();
  const claimed = ledger.markTriggerRunning(name, nowIso, staleCutoffIso);
  if (!claimed) {
    throw new Error(`trigger '${name}' is already running`);
  }
  // Explicit catch — `void` discards the promise without wiring rejection
  // handling. If `runTriggerNow` throws synchronously OR rejects before its
  // own try/catch (e.g. JSON.parse on a corrupted config_json, an import
  // resolution issue under bun --hot, anything that would otherwise be a
  // silent unhandled rejection), we surface the failure AND clear the
  // stranded `running_started_at` so the row doesn't stay "running" until
  // the next boot sweep.
  runTriggerNow(name).catch((err) => {
    const message = (err as Error).message ?? "runTriggerNow rejected";
    logEvent("trigger.run.fire_failed", { name, message_120: message.slice(0, 120) }, "error");
    try {
      ledger.updateTriggerLastPoll({
        name,
        summary: { error: `fire_failed: ${message}`, at: new Date().toISOString() },
      });
    } catch {
      // updateTriggerLastPoll itself failing is hopeless; the boot sweep
      // is the safety net.
    }
  });
}

/**
 * Run a single trigger by name immediately, ignoring its scheduled dueAt
 * and the enabled flag. Useful for the /queue UI's "Run now" affordance:
 * the founder explicitly asked, so we bypass the scheduler. Persists
 * last_polled_at + last_run_summary so the watch loop respects the run.
 */
export async function runTriggerNow(name: string): Promise<TriggerRunOutcome> {
  startRun();
  const spec = TRIGGERS.find((t) => t.name === name);
  if (!spec) throw new Error(`unknown trigger '${name}'`);
  const ledger = getLedger();
  const stored = ledger.getTrigger(name);
  if (!stored) {
    ledger.upsertTrigger({
      name,
      configJson: JSON.stringify(spec.defaultConfig),
      enabled: spec.enabledByDefault !== false,
    });
  }
  const config = stored?.config_json
    ? (JSON.parse(stored.config_json) as Record<string, unknown>)
    : spec.defaultConfig;
  const intervalMs = effectiveIntervalMs(spec, config);
  // Readiness re-check: fireTriggerNow already gates ad-hoc runs, but a direct
  // CLI/test caller hitting runTriggerNow should get the same protection.
  const readiness = checkReadiness(spec, config);
  if (!readiness.ready) {
    const message = `not ready: ${readiness.reason}`;
    ledger.updateTriggerLastPoll({
      name,
      summary: { error: message, at: new Date().toISOString() },
    });
    logEvent("trigger.run.skipped", { name, source: "ad_hoc", reason: readiness.reason });
    return { name, fired: false, error: message, nextDueInMs: intervalMs };
  }
  const startedAt = Date.now();
  logEvent("trigger.run.start", { name, source: "ad_hoc" });
  try {
    const result = await spec.run(config);
    ledger.updateTriggerLastPoll({ name, summary: result });
    logEvent("trigger.run.done", {
      name,
      duration_ms: Date.now() - startedAt,
      candidates: result.candidates,
      enqueued: result.enqueued,
      dropped_icp: result.droppedIcp,
      dropped_dup: result.droppedDuplicate,
      dropped_enrich: result.droppedEnrichment,
      cost_usd: result.costUsd,
      halted: result.halted ?? null,
    });
    return { name, fired: true, result, nextDueInMs: intervalMs };
  } catch (err) {
    const message = (err as Error).message ?? "unknown error";
    ledger.updateTriggerLastPoll({
      name,
      summary: { error: message, at: new Date().toISOString() },
    });
    logEvent(
      "trigger.run.error",
      {
        name,
        duration_ms: Date.now() - startedAt,
        message_120: message.slice(0, 120),
      },
      "error",
    );
    return { name, fired: true, error: message, nextDueInMs: intervalMs };
  }
}

/**
 * Run every registered trigger that's due. Persists last_polled_at + last_run_summary.
 * Returns one outcome per trigger so the caller can log + decide sleep duration.
 */
export async function runDueTriggers(): Promise<TriggerRunOutcome[]> {
  startRun();
  const ledger = getLedger();
  const now = Date.now();
  const outcomes: TriggerRunOutcome[] = [];
  logEvent("watch.tick.start", { trigger_count: TRIGGERS.length });

  for (const spec of TRIGGERS) {
    const stored = ledger.getTrigger(spec.name);
    const defaultEnabled = spec.enabledByDefault !== false;
    // Initialize on first sight.
    if (!stored) {
      ledger.upsertTrigger({
        name: spec.name,
        configJson: JSON.stringify(spec.defaultConfig),
        enabled: defaultEnabled,
      });
    }

    const config = stored?.config_json
      ? (JSON.parse(stored.config_json) as Record<string, unknown>)
      : spec.defaultConfig;
    const intervalMs = effectiveIntervalMs(spec, config);

    const enabled = stored ? Boolean(stored.enabled) : defaultEnabled;
    if (!enabled) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: intervalMs });
      continue;
    }

    // Readiness gate: skip without touching last_polled_at so the watch loop
    // retries on the *next* tick once config is fixed, not on the next
    // interval boundary.
    const readiness = checkReadiness(spec, config);
    if (!readiness.ready) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: intervalMs });
      logEvent("trigger.run.skipped", {
        name: spec.name,
        source: "watch",
        reason: readiness.reason,
      });
      continue;
    }

    const lastPolledMs = stored?.last_polled_at ? new Date(stored.last_polled_at).getTime() : 0;
    const dueAt = lastPolledMs + intervalMs;
    if (now < dueAt) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: dueAt - now });
      continue;
    }

    // Atomic claim — same pattern as fireTriggerNow (line 436-441) so the
    // scheduled-fire path can't race with a manual click on the same trigger
    // and double-spend. `staleCutoffIso` lets a fresh tick reclaim a row
    // whose previous `running_started_at` is older than MAX_RUN_AGE_MS (the
    // freshness gate already says "not running" but the marker never got
    // cleared — process killed before updateTriggerLastPoll ran, no boot
    // sweep yet). Cleared by updateTriggerLastPoll on success/error.
    const claimNowIso = new Date().toISOString();
    const staleCutoffIso = new Date(Date.now() - MAX_RUN_AGE_MS).toISOString();
    const claimed = ledger.markTriggerRunning(spec.name, claimNowIso, staleCutoffIso);
    if (!claimed) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: intervalMs });
      logEvent("trigger.run.skipped", {
        name: spec.name,
        source: "watch",
        reason: "already-running",
      });
      continue;
    }

    const startedAt = Date.now();
    logEvent("trigger.run.start", { name: spec.name, source: "watch" });
    try {
      const result = await spec.run(config);
      ledger.updateTriggerLastPoll({ name: spec.name, summary: result });
      logEvent("trigger.run.done", {
        name: spec.name,
        duration_ms: Date.now() - startedAt,
        candidates: result.candidates,
        enqueued: result.enqueued,
        dropped_icp: result.droppedIcp,
        dropped_dup: result.droppedDuplicate,
        dropped_enrich: result.droppedEnrichment,
        cost_usd: result.costUsd,
        halted: result.halted ?? null,
      });
      outcomes.push({ name: spec.name, fired: true, result, nextDueInMs: intervalMs });
    } catch (err) {
      const message = (err as Error).message ?? "unknown error";
      ledger.updateTriggerLastPoll({
        name: spec.name,
        summary: { error: message, at: new Date().toISOString() },
      });
      logEvent(
        "trigger.run.error",
        {
          name: spec.name,
          duration_ms: Date.now() - startedAt,
          message_120: message.slice(0, 120),
        },
        "error",
      );
      outcomes.push({
        name: spec.name,
        fired: true,
        error: message,
        nextDueInMs: intervalMs,
      });
    }
  }
  logEvent("watch.tick.done", { fired: outcomes.filter((o) => o.fired).length });
  return outcomes;
}

export function nextSleepMs(outcomes: TriggerRunOutcome[]): number {
  if (outcomes.length === 0) return 60 * 60 * 1000;
  const min = Math.min(...outcomes.map((o) => o.nextDueInMs));
  // Floor at 60s, ceiling at 1h to keep the loop responsive without busy-waiting.
  return Math.max(60_000, Math.min(60 * 60 * 1000, min));
}
