import {
  getLedger,
  logEvent,
  safeParseJsonRecord,
  startRun,
  type TriggerRow,
} from "@oneshot-gtm/core";
import { type CohortEntry, runAcceleratorBatchFinder } from "./accelerator-batch.ts";
import { deriveCohortLabel } from "./_yc-oss-adapter.ts";
import { runBreakupReviveFinder } from "./breakup-revive.ts";
import { runCivicAgendaFinder } from "./civic-agenda.ts";
import { runGitHubStarsFinder, type RepoWatch } from "./github-stars.ts";
import { runGitHubTopicsFinder } from "./github-topics.ts";
import { runGovSolicitationFinder } from "./gov-solicitation.ts";
import { runHiringSignalFinder } from "./hiring-signal.ts";
import { runJobChangeFinder } from "./job-change.ts";
import { runLocalBusinessFinder } from "./local-business.ts";
import { runLumaFinder } from "./luma.ts";
import { runPodcastGuestFinder } from "./podcast-guest.ts";
import { runPostFundingFinder } from "./post-funding.ts";
import { runShowHnFinder } from "./show-hn.ts";
import { runXRepostersFinder } from "./x-reposters.ts";
import type { XSeed } from "./_x-types.ts";
import type { HarvestKnobs } from "./_x-engine.ts";
import type { FinderResult } from "./_types.ts";
import { researchNewQueueRows } from "./_product-research.ts";

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

/** Run a finder, then attach product context to only the pending rows it created. */
export async function runFinderWithProductResearch(
  spec: TriggerSpec,
  config: Record<string, unknown>,
): Promise<FinderResult> {
  const ledger = getLedger();
  const afterId = ledger.latestQueueId();
  const result = await spec.run(config);
  await researchNewQueueRows({
    afterId,
    result,
    enabled: config["productResearch"] !== false,
    priorSdkCostUsd: result.sdkCostUsd ?? result.costUsd,
    ...(typeof config["maxCostUsd"] === "number"
      ? { maxCostUsd: config["maxCostUsd"] as number }
      : {}),
  });
  return result;
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
const PRODUCT_RESEARCH_DEFAULT = { productResearch: true } as const;

/**
 * Default cohort sweep for `accelerator-batch`. Only yc-* entries hit the
 * structured yc-oss/api directory; the rest use the websearch + LLM-extract
 * adapter with spotty recall. Per-cohort failures are isolated — the run only
 * halts when EVERY cohort comes back empty.
 * ROTATION: goes stale within ~3 months; founders edit `cohorts[]` in the
 * /queue trigger config as new batches announce.
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
    defaultConfig: { ...PRODUCT_RESEARCH_DEFAULT, sinceDays: 1, limit: 25, maxCostUsd: 5 },
    configBrief:
      "Polls Hacker News Algolia for recent Show HN posts, ICP-filters them, enriches founder contact, and enqueues them for review. Config: `sinceDays` (lookback window, default 1), `limit` (max kept, default 25), `maxCostUsd` (per-run spend cap), `minPoints` (upvote floor, default 5 — posts below it drop as low-signal). Defaults work for most ICPs — bump sinceDays to 7+ if your ICP is niche enough that daily volume is thin. STRATEGIST NOTE: minPoints is a MOTION choice, not noise control — selling a paid product, keep ≥5 (traction = budget); driving adoption of a founder tool, drop to 1-2 (the quiet launch IS the pain signal).",
    run: (cfg) =>
      runShowHnFinder({
        dryRun: false,
        sinceDays: (cfg["sinceDays"] as number) ?? 1,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
        ...(typeof cfg["minPoints"] === "number" ? { minPoints: cfg["minPoints"] as number } : {}),
      }),
  },
  {
    name: "accelerator-batch",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    // Every known incubator × {latest, previous-latest}; editable in /queue.
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
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
      ...PRODUCT_RESEARCH_DEFAULT,
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
      ...PRODUCT_RESEARCH_DEFAULT,
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
      ...PRODUCT_RESEARCH_DEFAULT,
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
      ...PRODUCT_RESEARCH_DEFAULT,
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
    // Luma upcoming-event hosts + featured guests: per-city page discovery
    // (webSearch fallback), keyword + LLM topic/ICP gate before any paid read,
    // attendees from Luma's public event JSON.
    name: "luma-events",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
      topics: ["AI", "founders"] as string[],
      cities: ["San Francisco", "New York"] as string[],
      sinceDays: 14,
      yourEdge: "",
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Discovers upcoming Luma events from Luma's per-city pages, gates each event on the founder's topics + ICP (a free keyword pre-filter, then one LLM relevance call on the event name) BEFORE any paid read, then pitches the event's hosts + featured guests — Luma's public event JSON carries their LinkedIn/website, so contact resolution lands. Coverage per event: the hosts (always public) + up to ~10 featured guests when the organizer shows 'Who's Coming'. Each row is tagged Host or Guest and the email is drafted role-aware. Config: `topics` (phrases whose words must appear in / relate to the event name — e.g. ['AI agents', 'MCP']; they gate events, not search queries), `cities` (major hubs work best — San Francisco, New York, LA, London, etc. map to Luma city pages; other cities fall back to webSearch), `yourEdge` (the angle on why your product helps event-going people, REQUIRED; may hold multiple `//`-separated angles — the email picks the ONE that fits each event's topic, so never flatten them into one sentence), `sinceDays` (forward-looking window in days — events further out than this are dropped), `limit`, `maxCostUsd`. STRATEGIST DUTY: align topics to your ICP's actual gathering spots (AI hackers ≠ growth marketers) and include the vocabulary event names actually use (e.g. 'agents', 'hackathon', 'MCP').",
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
    // GitHub-Topic-driven repo finder (free Search API, `topic:<slug>`).
    // Routes to stack-consolidation, or competitor-switch on a
    // `directCompetitors` match. Ships empty so nothing fires until configured.
    name: "github-topics",
    defaultIntervalMs: 12 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
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
      "Discovers repos via GitHub Topic pages (`topic:<slug>` queries on the GitHub Search API), then scans each candidate's package.json / pyproject.toml / requirements.txt / .env.example via the GitHub Contents API to detect which API vendors the repo actually uses. Routes each candidate to one of two motion plays: stack-consolidation (default — pitch collapsing the vendor sprawl into one SDK) or competitor-switch (when a detected vendor is on `directCompetitors` — a head-on 'switch from X' pitch). Required config: `topics` (GitHub topic slugs the founder's ICP overlaps with — lowercase, hyphenated, EXACT GitHub-canonical form; singular vs plural matters), `vendors` (the founder's competitive landscape — the API vendors they aim to replace), `yourEdge` (the pitch angle handed to the email; may hold multiple `//`-separated angles — the email picks the ONE that fits each prospect's stack, so never flatten them). Optional `directCompetitors`: a subset of `vendors` the founder competes with head-on (same canonical spelling, matched case-insensitively); a candidate using one routes to competitor-switch instead of stack-consolidation. Empty by default, so every candidate is stack-consolidation until set. VOCAB SEMANTICS: each `vendors` string is substring-matched (case-insensitive) against manifest deps + env-var keys — so `twilio` matches `twilio`, `twilio-node`, `@twilio/voice-sdk`, AND `TWILIO_ACCOUNT_SID`. There is NO hardcoded vendor list; oneshot-gtm is a generic founder tool and competitive vocabularies vary entirely by founder. STRATEGIST DUTY: when you (the strategist) have enough context about the founder's product/ICP, proactively propose BOTH `topics` AND `vendors` via apply-config — topics are GitHub category slugs aligned to ICP; vendors are the API competitors the founder replaces. The founder shouldn't have to enumerate either by hand. Other config: `minStars` (filter, default 5), `maxAgeDays` (default 90), `minVendors` (gate: how many distinct vocab vendors must match in a candidate's manifests; default 1), `concurrency` (in-flight workers; default 3), `useDeepResearch` (default true), `limit`, `maxCostUsd`.",
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
      ...PRODUCT_RESEARCH_DEFAULT,
      repos: [] as Array<{ repo: string; rel: string; label?: string; repoEdge?: string }>,
      yourEdge: "",
      sinceDays: 30,
      concurrency: 3,
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      'Finds recent stargazers of repos you watch and turns them into prospects. Config: `repos` (array of `{repo:"owner/name", rel:"competitor"|"adjacent", label?, repoEdge?}` — tag a repo `competitor` to pitch a switch (→ competitor-switch) or `adjacent` for a complementary intro (→ repo-interest); `label` is the human name, else derived from the repo; `repoEdge` is an OPTIONAL per-repo line on why THAT repo is notable + the respectful bridge to your offer, used by repo-interest as a shared-taste nod that also shapes the pitch — e.g. a privacy-first repo leads with control/auditability, not "we do it for you"), `yourEdge` (the pitch angle fed to whichever play, REQUIRED; may hold multiple `//`-separated angles — the email picks the ONE that fits each prospect, so never flatten them), `sinceDays` (recency window, default 30), `limit`, `maxCostUsd`. Needs `GITHUB_TOKEN` for any volume. STRATEGIST DUTY: pick repos your buyers\' current tools live in; tag the ones you replace as `competitor`, the rest `adjacent`; give each adjacent repo a `repoEdge` so the intro nods to why they chose THAT tool.',
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
    name: "local-business",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
      jobTitles: [] as string[],
      industries: [] as string[],
      locations: [] as string[],
      employeeRange: "",
      keywords: [] as string[],
      yourEdge: "",
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Reaches businesses with no GitHub repo, no Show HN post, no funding round and no accelerator batch — the local-business/main-street population the other ten finders can't touch. One `peopleSearch` call ($0.01 flat) returns up to 500 people matching `jobTitles` × `industries` × `locations` × `employeeRange`, many already carrying a `best_work_email` — those skip findEmail/verifyEmail entirely and go straight to the person-level ICP gate, so a run where every result has an email costs about one search call, not one per candidate. Config: `jobTitles` (roles that make the buying decision — e.g. 'Owner', 'Office Manager', 'Practice Manager'), `industries` (e.g. 'Dental Practices', 'HVAC Contractors', 'Independent Restaurants'), `locations` (metro/city/state filters), `employeeRange` (company-size band, e.g. '1-10', '11-50'), `keywords` (free-text refinement), `yourEdge` (the free-pilot pitch — what you set up for them free and what it saves them, REQUIRED, fed to the `free-pilot` play), `limit`, `maxCostUsd`. When `industries` is set and `jobTitles` is empty, the search is business-shaped: a `companySearch` pass resolves matching company domains first, then `peopleSearch` is scoped to those domains instead of searching on industry directly. STRATEGIST DUTY: propose `jobTitles` AND `industries` proactively from the founder's ICP — a pre-PMF founder selling to dental practices or HVAC companies shouldn't have to enumerate either by hand.",
    readiness: (cfg) => {
      const jobTitles = Array.isArray(cfg["jobTitles"])
        ? (cfg["jobTitles"] as unknown[]).filter((t) => typeof t === "string" && t.trim())
        : [];
      const industries = Array.isArray(cfg["industries"])
        ? (cfg["industries"] as unknown[]).filter((t) => typeof t === "string" && t.trim())
        : [];
      if (jobTitles.length === 0 && industries.length === 0) {
        return { ready: false, reason: "set `jobTitles` or `industries` (at least one)" };
      }
      const edge = cfg["yourEdge"];
      if (typeof edge !== "string" || edge.trim().length === 0) {
        return { ready: false, reason: "set `yourEdge` — your one-line free-pilot pitch" };
      }
      return { ready: true };
    },
    run: (cfg) => {
      const strArray = (key: string): string[] =>
        Array.isArray(cfg[key])
          ? (cfg[key] as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
      return runLocalBusinessFinder({
        dryRun: false,
        jobTitles: strArray("jobTitles"),
        industries: strArray("industries"),
        locations: strArray("locations"),
        keywords: strArray("keywords"),
        ...(typeof cfg["employeeRange"] === "string" && cfg["employeeRange"].trim().length > 0
          ? { employeeRange: (cfg["employeeRange"] as string).trim() }
          : {}),
        yourEdge: typeof cfg["yourEdge"] === "string" ? cfg["yourEdge"] : "",
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      });
    },
  },
  {
    name: "x-reposters",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
      seeds: [] as Array<{ handle: string; edge?: string }>,
      engine: "xapi",
      laneSplit: 0.5,
      limit: 12,
      launchDate: null,
      ownHandles: [] as string[],
      maxCostUsd: 5,
    },
    configBrief:
      'Watches seed X accounts and harvests everyone who reposted/quoted their recent tweets, in two lanes: FOUNDER (bio + a real product link say they build things → x-repost-intro email behind the person-ICP gate, normal cadence) and AMPLIFIER (dev/AI audience with reach → x-amplify email asking for a launch-day look+repost, or x-amplify-dm — a hand-sent DM/reply draft — when no email is found). Config: `seeds` (array of `{handle, edge?}` — `edge` is an OPTIONAL founder-authored line on why THAT seed\'s audience matters, shaping the founder-lane framing like github-stars\' repoEdge; pick seeds whose reposters BUILD things — influencer seeds produce influencer reposters and starve the founder lane), `engine` ("xapi" default = first-party X API at ~$0.01/user read, needs X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET OAuth1 user-context creds in .env; "twitterapiio" = third-party scraper ~55x cheaper, needs TWITTERAPI_IO_KEY — a deliberate cost-vs-first-party trade), `maxSpendPerRun` (X READ spend ceiling — defaults $5 on xapi / $1 on twitterapiio; the run stops at the ceiling and keeps what it harvested), `maxCostUsd` (SDK/LLM spend cap, separate), `laneSplit` (founder share of `limit`, default 0.5 — lanes rank within themselves, never against each other), `limit` (per-run enqueue cap, default 12), `launchDate` (ISO date — the ONLY timing fact amplifier drafts may state, always absolute; sends spread over weeks so relative phrasing goes stale), `ownHandles` (your own X accounts, never contacted), `replay: true` (one run re-scoring the last paid harvest at ZERO X spend — use for filter tuning; both providers bill per resource returned). HARD RULES the plays enforce: never pitch the product to amplifiers; never ask founders for a repost. Note: unlike GitHub finders, the HARVEST is the paid step — a dry run still spends X reads unless `replay` is set.',
    readiness: (cfg) => {
      const seeds = Array.isArray(cfg["seeds"]) ? cfg["seeds"] : [];
      const valid = seeds.filter(
        (s) =>
          s &&
          typeof s === "object" &&
          typeof (s as Record<string, unknown>)["handle"] === "string" &&
          ((s as Record<string, unknown>)["handle"] as string).trim().length > 0,
      );
      if (valid.length === 0) {
        return {
          ready: false,
          reason: "set `seeds` (each `{handle}` — accounts whose reposters you want)",
        };
      }
      if (cfg["engine"] === "twitterapiio") {
        if (!process.env["TWITTERAPI_IO_KEY"]) {
          return {
            ready: false,
            reason: "set TWITTERAPI_IO_KEY in .env for the twitterapi.io engine",
          };
        }
        return { ready: true };
      }
      const missing = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"].filter(
        (k) => !process.env[k],
      );
      if (missing.length > 0) {
        return {
          ready: false,
          reason: `set ${missing.join(", ")} in .env (OAuth1 user-context — app-only bearer tokens 401 on v2 reads)`,
        };
      }
      return { ready: true };
    },
    run: (cfg) => {
      const seeds: XSeed[] = (Array.isArray(cfg["seeds"]) ? cfg["seeds"] : [])
        .map((s): XSeed | null => {
          if (!s || typeof s !== "object") return null;
          const e = s as Record<string, unknown>;
          const handle =
            typeof e["handle"] === "string" ? e["handle"].trim().replace(/^@/, "") : "";
          if (handle.length === 0) return null;
          const edge = typeof e["edge"] === "string" ? e["edge"].trim() : "";
          return { handle, ...(edge ? { edge } : {}) };
        })
        .filter((s): s is XSeed => s !== null);
      return runXRepostersFinder({
        dryRun: false,
        seeds,
        engine: cfg["engine"] === "twitterapiio" ? "twitterapiio" : "xapi",
        ...(typeof cfg["maxSpendPerRun"] === "number"
          ? { maxSpendPerRun: cfg["maxSpendPerRun"] as number }
          : {}),
        // typeof guards, not casts: a stringly config value ("half") would
        // flow through as NaN, zero both lanes, and blame the seeds.
        laneSplit: typeof cfg["laneSplit"] === "number" ? cfg["laneSplit"] : 0.5,
        limit: typeof cfg["limit"] === "number" ? cfg["limit"] : 12,
        ...(typeof cfg["launchDate"] === "string" && cfg["launchDate"].trim()
          ? { launchDate: (cfg["launchDate"] as string).trim() }
          : {}),
        ownHandles: Array.isArray(cfg["ownHandles"])
          ? (cfg["ownHandles"] as unknown[]).filter((h): h is string => typeof h === "string")
          : [],
        ...(cfg["knobs"] && typeof cfg["knobs"] === "object"
          ? { knobs: cfg["knobs"] as Partial<HarvestKnobs> }
          : {}),
        ...(cfg["replay"] === true ? { replay: true } : {}),
        ...(typeof cfg["replayDay"] === "string" ? { replayDay: cfg["replayDay"] as string } : {}),
        maxCostUsd: typeof cfg["maxCostUsd"] === "number" ? cfg["maxCostUsd"] : 5,
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
  {
    // SAM.gov Get Opportunities: every notice publishes a full pointOfContact
    // (name, title, email, phone), so this finder needs no findEmail/verifyEmail
    // at all — near-zero SDK spend per candidate.
    name: "gov-solicitation",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
      naics: [] as string[],
      noticeTypes: ["r", "p"] as string[],
      agencies: [] as string[],
      sinceDays: 30,
      yourEdge: "",
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Polls SAM.gov's Get Opportunities API for federal notices matching your NAICS codes, and pitches the notice's own published point of contact — no findEmail/verifyEmail spend, since the notice already carries a name, title, email and phone. Config: `naics` (one or more 6-digit NAICS codes describing what you sell — REQUIRED), `noticeTypes` (SAM.gov `ptype` codes, default `['r','p']`), `agencies` (optional case-insensitive substring allowlist to narrow to agencies you actually want to sell to), `sinceDays` (lookback window for `postedFrom`, default 30, capped at 365 — SAM.gov's own one-year max range), `yourEdge` (your one-line pitch, REQUIRED), `limit`, `maxCostUsd`. Needs `SAM_GOV_API_KEY` in .env (free registration on sam.gov). STRATEGIST NOTE: `noticeTypes` is a MOTION choice, not a filter — `r` (Sources Sought) and `p` (Presolicitation) reach the agency WHILE the requirement is still being written, the one window where a startup with no past-performance record can shape it; `o` (Solicitation) reaches it AFTER the requirement is fixed, when a competitor with an incumbent relationship has usually already shaped it. Default to r/p unless the founder explicitly wants to bid on finished RFPs. `r`/`p` notices route to `sources-sought`; everything else routes to `design-partner-loi`.",
    readiness: (cfg) => {
      const naics = Array.isArray(cfg["naics"]) ? cfg["naics"] : null;
      if (!naics || naics.filter((n) => typeof n === "string" && n.trim()).length === 0) {
        return { ready: false, reason: "set `naics` (one or more 6-digit NAICS codes)" };
      }
      if (!process.env["SAM_GOV_API_KEY"]) {
        return { ready: false, reason: "set SAM_GOV_API_KEY in .env" };
      }
      const edge = cfg["yourEdge"];
      if (typeof edge !== "string" || edge.trim().length === 0) {
        return { ready: false, reason: "set `yourEdge` — one-line pitch for the agency POC" };
      }
      return { ready: true };
    },
    run: (cfg) =>
      runGovSolicitationFinder({
        dryRun: false,
        ...(Array.isArray(cfg["naics"])
          ? { naics: (cfg["naics"] as unknown[]).filter((n): n is string => typeof n === "string") }
          : {}),
        ...(Array.isArray(cfg["noticeTypes"])
          ? {
              noticeTypes: (cfg["noticeTypes"] as unknown[]).filter(
                (t): t is string => typeof t === "string",
              ),
            }
          : {}),
        ...(Array.isArray(cfg["agencies"])
          ? {
              agencies: (cfg["agencies"] as unknown[]).filter(
                (a): a is string => typeof a === "string",
              ),
            }
          : {}),
        ...(typeof cfg["yourEdge"] === "string" ? { yourEdge: cfg["yourEdge"] as string } : {}),
        sinceDays: (cfg["sinceDays"] as number) ?? 30,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    // Legistar/Granicus council agendas: keyword-gate agenda item titles free,
    // then one LLM relevance call on the survivors — same pre-spend discipline
    // as luma.ts. The body's own OfficeRecords contact is used; no SDK spend.
    name: "civic-agenda",
    defaultIntervalMs: 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      ...PRODUCT_RESEARCH_DEFAULT,
      cities: [] as string[],
      keywords: [] as string[],
      sinceDays: 30,
      yourEdge: "",
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Scans city/county council agendas via the Legistar/Granicus Web API for items matching your keywords, and pitches the meeting body's own published contact. Config: `cities` (city names mapped to a Legistar client — see `_civic-legistar.ts` for the curated list; unmapped cities are skipped and logged), `keywords` (free word-boundary gate applied to agenda item TITLES before any paid call — e.g. ['AI', 'automation', 'software'] — REQUIRED), `sinceDays` (forward-looking window, default 30), `yourEdge` (your one-line pilot pitch, REQUIRED), `limit`, `maxCostUsd`. No API key needed (Legistar is a public, keyless JSON API). STRATEGIST DUTY: keywords must match the VOCABULARY agenda clerks actually use, not marketing language — 'body-worn camera' beats 'law enforcement AI', 'permitting software' beats 'GovTech'. Routes to `civic-pilot`.",
    readiness: (cfg) => {
      const cities = Array.isArray(cfg["cities"]) ? cfg["cities"] : null;
      if (!cities || cities.filter((c) => typeof c === "string" && c.trim()).length === 0) {
        return { ready: false, reason: "set `cities` (e.g. ['New York', 'Chicago'])" };
      }
      const keywords = Array.isArray(cfg["keywords"]) ? cfg["keywords"] : null;
      if (!keywords || keywords.filter((k) => typeof k === "string" && k.trim()).length === 0) {
        return {
          ready: false,
          reason: "set `keywords` (agenda-title gate, e.g. ['AI','automation'])",
        };
      }
      const edge = cfg["yourEdge"];
      if (typeof edge !== "string" || edge.trim().length === 0) {
        return { ready: false, reason: "set `yourEdge` — one-line pilot pitch" };
      }
      return { ready: true };
    },
    run: (cfg) =>
      runCivicAgendaFinder({
        dryRun: false,
        ...(Array.isArray(cfg["cities"])
          ? {
              cities: (cfg["cities"] as unknown[]).filter(
                (c): c is string => typeof c === "string",
              ),
            }
          : {}),
        ...(Array.isArray(cfg["keywords"])
          ? {
              keywords: (cfg["keywords"] as unknown[]).filter(
                (k): k is string => typeof k === "string",
              ),
            }
          : {}),
        ...(typeof cfg["yourEdge"] === "string" ? { yourEdge: cfg["yourEdge"] as string } : {}),
        sinceDays: (cfg["sinceDays"] as number) ?? 30,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
];

/**
 * Resolve the active interval for a trigger: stored config_json may override
 * the registry's defaultIntervalMs via `intervalMs`.
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
  /** Wall-clock of the run, present only when `fired`. */
  duration_ms?: number;
  /** ms until this trigger is next due */
  nextDueInMs: number;
  /** Named scheduler skip reason (disabled/not-due remain unnamed). */
  skippedReason?: string;
}

export const DEFAULT_APPROVAL_RATE_THRESHOLD = 0.1;
export const DEFAULT_APPROVAL_RATE_WINDOW_DAYS = 30;
export const DEFAULT_APPROVAL_RATE_MIN_SAMPLES = 100;

export interface FinderApprovalHealth {
  approved: number;
  reviewed: number;
  rate: number | null;
  threshold: number;
  windowDays: number;
  minSamples: number;
  sufficientData: boolean;
  deprioritized: boolean;
  reason: string | null;
}

/** Pure boundary logic shared by scheduler, API, doctor, and tests. */
export function evaluateFinderApprovalHealth(input: {
  approved: number;
  reviewed: number;
  threshold?: number;
  windowDays?: number;
  minSamples?: number;
}): FinderApprovalHealth {
  const threshold = input.threshold ?? DEFAULT_APPROVAL_RATE_THRESHOLD;
  const windowDays = input.windowDays ?? DEFAULT_APPROVAL_RATE_WINDOW_DAYS;
  const minSamples = input.minSamples ?? DEFAULT_APPROVAL_RATE_MIN_SAMPLES;
  const rate = input.reviewed > 0 ? input.approved / input.reviewed : null;
  const sufficientData = input.reviewed >= minSamples;
  const deprioritized = sufficientData && rate !== null && rate < threshold;
  return {
    ...input,
    rate,
    threshold,
    windowDays,
    minSamples,
    sufficientData,
    deprioritized,
    reason: deprioritized ? "low-approval-rate" : null,
  };
}

export function finderApprovalHealth(
  name: string,
  config: Record<string, unknown>,
): FinderApprovalHealth {
  const numberOr = (key: string, fallback: number): number => {
    const value = config[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const threshold = Math.min(1, numberOr("approvalRateThreshold", DEFAULT_APPROVAL_RATE_THRESHOLD));
  const windowDays = Math.max(
    1,
    numberOr("approvalRateWindowDays", DEFAULT_APPROVAL_RATE_WINDOW_DAYS),
  );
  const minSamples = Math.max(
    1,
    Math.floor(numberOr("approvalRateMinSamples", DEFAULT_APPROVAL_RATE_MIN_SAMPLES)),
  );
  const stats = getLedger().finderApprovalStats({
    finder: name,
    sinceIso: new Date(Date.now() - windowDays * 86_400_000).toISOString(),
  });
  return evaluateFinderApprovalHealth({ ...stats, threshold, windowDays, minSamples });
}

/**
 * Maximum age before an in-flight `running_started_at` is considered a
 * killed-by-restart zombie and swept. 4h leaves generous headroom over real
 * finder runtimes; a run that exceeds it gets marked killed and re-claimable —
 * bounded duplicate spend beats a permanently-stuck 409.
 */
export const MAX_RUN_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * Truth of "is this trigger running" lives in the ledger and survives server
 * restart. The freshness gate hides stale rows the boot sweep hasn't cleaned
 * up yet — never report "still running" for a row older than any real run.
 */
/**
 * Pure helper (unit-testable without the ledger): parsed start-epoch when the
 * timestamp is valid AND within MAX_RUN_AGE_MS of `nowMs`; null otherwise.
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
 * Stored config with corruption fallback — one corrupt config_json row must
 * not stall every trigger, so it runs on defaults with a warning instead.
 */
export function storedTriggerConfig(
  stored: TriggerRow | null,
  spec: TriggerSpec,
): Record<string, unknown> {
  if (!stored?.config_json) return spec.defaultConfig;
  const parsed = safeParseJsonRecord(stored.config_json);
  if (parsed == null) {
    logEvent("trigger.config.corrupt", { name: spec.name }, "warn");
    return spec.defaultConfig;
  }
  return parsed;
}

/**
 * Fire-and-forget wrapper around `runTriggerNow`. Throws synchronously if the
 * trigger is unknown, already running, or unready; finder errors are already
 * persisted by runTriggerNow. A process killed mid-run leaves
 * `running_started_at` set — the cold-boot sweep writes `killed_by_restart`.
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
  const config = storedTriggerConfig(stored, spec);
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
  // Atomic claim — no TOCTOU race: exactly one of two concurrent fires wins.
  // `staleCutoffIso` lets a fresh click reclaim a row whose stale
  // `running_started_at` never got cleared, instead of 409ing every retry.
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - MAX_RUN_AGE_MS).toISOString();
  const claimed = ledger.markTriggerRunning(name, nowIso, staleCutoffIso);
  if (!claimed) {
    throw new Error(`trigger '${name}' is already running`);
  }
  // Explicit catch (not `void`): a rejection before runTriggerNow's own
  // try/catch must surface AND clear the stranded `running_started_at`.
  runTriggerNow(name, { claimHeld: true }).catch((err) => {
    const message = (err as Error).message ?? "runTriggerNow rejected";
    logEvent("trigger.run.fire_failed", { name, message_120: message.slice(0, 120) }, "error");
    try {
      ledger.updateTriggerLastPoll({
        name,
        summary: { error: `fire_failed: ${message}`, at: new Date().toISOString() },
      });
    } catch {
      // The boot sweep is the safety net.
    }
  });
}

/**
 * Run a single trigger immediately, ignoring dueAt and the enabled flag
 * (the founder explicitly asked). Persists last_polled_at + last_run_summary
 * so the watch loop respects the run.
 */
export async function runTriggerNow(
  name: string,
  options: { claimHeld?: boolean } = {},
): Promise<TriggerRunOutcome> {
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
  const config = storedTriggerConfig(stored, spec);
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
  // fireTriggerNow claims before detaching its promise. Direct callers must
  // claim here so this exported boundary cannot overlap same-trigger runs.
  if (!options.claimHeld) {
    const claimNowIso = new Date().toISOString();
    const staleCutoffIso = new Date(Date.now() - MAX_RUN_AGE_MS).toISOString();
    if (!ledger.markTriggerRunning(name, claimNowIso, staleCutoffIso)) {
      const message = `trigger '${name}' is already running`;
      return { name, fired: false, error: message, nextDueInMs: intervalMs };
    }
  }
  const startedAt = Date.now();
  logEvent("trigger.run.start", { name, source: "ad_hoc" });
  try {
    const result = await runFinderWithProductResearch(spec, config);
    ledger.updateTriggerLastPoll({ name, summary: result });
    logEvent("trigger.run.done", {
      name,
      duration_ms: Date.now() - startedAt,
      candidates: result.candidates,
      enqueued: result.enqueued,
      dropped_icp: result.droppedIcp,
      dropped_role: result.droppedRole ?? 0,
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
export async function runDueTriggers(
  options: { ignoreApprovalRate?: boolean } = {},
): Promise<TriggerRunOutcome[]> {
  startRun();
  const ledger = getLedger();
  const now = Date.now();
  const outcomes: TriggerRunOutcome[] = [];
  logEvent("watch.tick.start", { trigger_count: TRIGGERS.length });

  for (const spec of TRIGGERS) {
    const stored = ledger.getTrigger(spec.name);
    const defaultEnabled = spec.enabledByDefault !== false;
    if (!stored) {
      ledger.upsertTrigger({
        name: spec.name,
        configJson: JSON.stringify(spec.defaultConfig),
        enabled: defaultEnabled,
      });
    }

    const config = storedTriggerConfig(stored, spec);
    const intervalMs = effectiveIntervalMs(spec, config);

    const enabled = stored ? Boolean(stored.enabled) : defaultEnabled;
    if (!enabled) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: intervalMs });
      continue;
    }

    // Readiness gate: skip without touching last_polled_at so a config fix is
    // picked up on the next tick, not the next interval boundary.
    const readiness = checkReadiness(spec, config);
    if (!readiness.ready) {
      outcomes.push({
        name: spec.name,
        fired: false,
        nextDueInMs: intervalMs,
        skippedReason: readiness.reason,
      });
      logEvent("trigger.run.skipped", {
        name: spec.name,
        source: "watch",
        reason: readiness.reason,
      });
      continue;
    }

    const approval = finderApprovalHealth(spec.name, config);
    if (approval.deprioritized && !options.ignoreApprovalRate) {
      outcomes.push({
        name: spec.name,
        fired: false,
        nextDueInMs: intervalMs,
        skippedReason: approval.reason ?? "low-approval-rate",
      });
      logEvent("trigger.run.skipped", {
        name: spec.name,
        source: "watch",
        reason: approval.reason,
        approval_rate: approval.rate,
        reviewed: approval.reviewed,
        threshold: approval.threshold,
      });
      continue;
    }

    const lastPolledMs = stored?.last_polled_at ? new Date(stored.last_polled_at).getTime() : 0;
    const dueAt = lastPolledMs + intervalMs;
    if (now < dueAt) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: dueAt - now });
      continue;
    }

    // Atomic claim — same pattern as fireTriggerNow, so the scheduled path
    // can't race a manual click and double-spend; `staleCutoffIso` reclaims a
    // stale marker. Cleared by updateTriggerLastPoll on success/error.
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
      const result = await runFinderWithProductResearch(spec, config);
      const durationMs = Date.now() - startedAt;
      ledger.updateTriggerLastPoll({ name: spec.name, summary: result });
      logEvent("trigger.run.done", {
        name: spec.name,
        duration_ms: durationMs,
        candidates: result.candidates,
        enqueued: result.enqueued,
        dropped_icp: result.droppedIcp,
        dropped_role: result.droppedRole ?? 0,
        dropped_dup: result.droppedDuplicate,
        dropped_enrich: result.droppedEnrichment,
        cost_usd: result.costUsd,
        halted: result.halted ?? null,
      });
      outcomes.push({
        name: spec.name,
        fired: true,
        result,
        duration_ms: durationMs,
        nextDueInMs: intervalMs,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = (err as Error).message ?? "unknown error";
      ledger.updateTriggerLastPoll({
        name: spec.name,
        summary: { error: message, at: new Date().toISOString() },
      });
      logEvent(
        "trigger.run.error",
        {
          name: spec.name,
          duration_ms: durationMs,
          message_120: message.slice(0, 120),
        },
        "error",
      );
      outcomes.push({
        name: spec.name,
        fired: true,
        error: message,
        duration_ms: durationMs,
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
