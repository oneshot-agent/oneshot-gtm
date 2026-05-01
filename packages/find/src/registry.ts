import { getLedger, logEvent, startRun } from "@oneshot-gtm/core";
import { runAcceleratorBatchFinder } from "./accelerator-batch.ts";
import { deriveCohortLabel } from "./_yc-oss-adapter.ts";
import { runBreakupReviveFinder } from "./breakup-revive.ts";
import { runGitHubTopicsFinder } from "./github-topics.ts";
import { runHiringSignalFinder } from "./hiring-signal.ts";
import { runJobChangeFinder } from "./job-change.ts";
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
    // Ships empty so the strategist is forced to propose a cohort tuned to the
    // founder's ICP rather than reflexively defaulting to YC. Each accelerator
    // (YC, Techstars, Antler, AI Grant, SPC, Neo, 500 Global, etc.) attracts a
    // different founder population — the right pick depends on who buys.
    defaultConfig: {
      cohort: "",
      cohortLabel: "",
      limit: 25,
      maxCostUsd: 5,
    },
    configBrief:
      "Pulls an accelerator cohort directory, ICP-filters companies, finds founder contact, enqueues for outreach. SHIPS EMPTY — pick a cohort that matches your ICP. Each accelerator surfaces a different founder population: YC for AI/infra-heavy startups, Techstars for vertical SaaS + corporate-partnered batches, Antler for solo founders + day-zero, AI Grant for AI-only research-product founders, SPC / Neo for senior-engineer founders, 500 Global for international + emerging markets. Config: `cohort` (tag — e.g. `yc-w26`, `techstars-toronto-2025`, `antler-nyc-q1-2026`, `ai-grant-2026`), `cohortLabel` (human label fed to email + search queries; auto-derived from cohort when not set), optional `adapter` (`yc-oss` | `websearch`; auto-picked from cohort prefix — yc-* tags use the free yc-oss/api directory, everything else falls back to web search), `limit`, `maxCostUsd`. STRATEGIST DUTY: when proposing this trigger, anchor the cohort recommendation in the founder's ICP — don't reflexively pick YC. If multiple accelerators fit, propose the top match and mention 1-2 alternatives in prose so the founder can swap.",
    readiness: (cfg) => {
      const cohort = cfg["cohort"];
      if (typeof cohort !== "string" || cohort.trim().length === 0) {
        return {
          ready: false,
          reason: "set `cohort` (ask the strategist to propose one tuned to your ICP)",
        };
      }
      return { ready: true };
    },
    run: (cfg) => {
      const cohort = (cfg["cohort"] as string) ?? "yc-w26";
      // Derive cohortLabel from cohort when the founder didn't set one
      // explicitly. This matters most after a `cohort` change — without
      // derivation the label would stay "YC W26" while the cohort points
      // at e.g. techstars, and the websearch adapter would query the wrong
      // program. Explicit override always wins.
      const labelFromCfg = typeof cfg["cohortLabel"] === "string" ? cfg["cohortLabel"].trim() : "";
      const cohortLabel = labelFromCfg.length > 0 ? labelFromCfg : deriveCohortLabel(cohort);
      return runAcceleratorBatchFinder({
        dryRun: false,
        cohort,
        cohortLabel,
        ...(cfg["adapter"] === "yc-oss" || cfg["adapter"] === "websearch"
          ? { adapter: cfg["adapter"] as "yc-oss" | "websearch" }
          : {}),
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
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
      "Scans Greenhouse / Lever / Workable / Ashby ATS pages for open roles that signal the company would buy THIS product. Config: `roles` (job titles whose existence implies a need for the product — e.g. 'Founding ML Engineer' for AI-infra products, 'Head of Compliance' for compliance products), `companies` (optional whitelist), `yourClaim` (one-sentence pitch about why your product makes that role's first 90 days easier — fed into the email), `sinceDays`, `limit`, `maxCostUsd`. The roles + yourClaim need to be tightly coupled to the product.",
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
    // GitHub-Topic-driven repo finder. Discovers via the (free) GitHub Search
    // API filtered by `topic:<slug>` — topic-tagged repos are pre-curated by
    // maintainers self-tagging, much higher signal-per-fetch than the
    // retired combo-search approach. Feeds competitor-switch (migration-
    // honesty pitch). Config-driven — the founder supplies topics + vendors
    // + edge via /queue; ships empty so nothing fires until configured.
    name: "github-topics",
    defaultIntervalMs: 12 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: {
      topics: [] as string[],
      vendors: [] as string[],
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
      "Discovers repos via GitHub Topic pages (`topic:<slug>` queries on the GitHub Search API), then scans each candidate's package.json / pyproject.toml / requirements.txt / .env.example via the GitHub Contents API to detect which API vendors the repo actually uses. Feeds the competitor-switch motion play. Required config: `topics` (GitHub topic slugs the founder's ICP overlaps with — lowercase, hyphenated, EXACT GitHub-canonical form; singular vs plural matters), `vendors` (the founder's competitive landscape — the API vendors they aim to replace), `yourEdge` (one-sentence pitch handed to the email). VOCAB SEMANTICS: each `vendors` string is substring-matched (case-insensitive) against manifest deps + env-var keys — so `twilio` matches `twilio`, `twilio-node`, `@twilio/voice-sdk`, AND `TWILIO_ACCOUNT_SID`. There is NO hardcoded vendor list; oneshot-gtm is a generic founder tool and competitive vocabularies vary entirely by founder. STRATEGIST DUTY: when you (the strategist) have enough context about the founder's product/ICP, proactively propose BOTH `topics` AND `vendors` via apply-config — topics are GitHub category slugs aligned to ICP; vendors are the API competitors the founder replaces. The founder shouldn't have to enumerate either by hand. Other config: `minStars` (filter, default 5), `maxAgeDays` (default 90), `minVendors` (gate: how many distinct vocab vendors must match in a candidate's manifests; default 1), `concurrency` (in-flight workers; default 3), `useDeepResearch` (default true), `limit`, `maxCostUsd`.",
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
      const yourEdge = typeof cfg["yourEdge"] === "string" ? cfg["yourEdge"] : "";
      return runGitHubTopicsFinder({
        dryRun: false,
        topics,
        vendors,
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
    // Ledger-only finder; no OneShot/LLM spend. Opt-in so it doesn't surprise
    // founders on fresh installs where the ledger is mostly empty.
    name: "breakup-revive",
    defaultIntervalMs: 7 * 24 * ONE_HOUR,
    enabledByDefault: false,
    defaultConfig: { minDays: 60, maxDays: 90, limit: 25 },
    configBrief:
      "Scans the founder's local prospect ledger for cold leads (no reply, marketable) within the day window and re-enqueues them for a pattern-interrupt revive. No OneShot/LLM spend (ledger-only). Config: `minDays` / `maxDays` (the cold-window — defaults 60-90), `limit`. Only enable when the founder has been sending for ≥2 months — empty ledger = no revives.",
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

export function listRunningTriggers(): string[] {
  const now = Date.now();
  return getLedger()
    .listTriggers()
    .filter((r) => freshRunningStartedAtMs(r.running_started_at, now) !== null)
    .map((r) => r.name);
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
