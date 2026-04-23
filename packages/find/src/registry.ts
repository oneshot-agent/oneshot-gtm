import { getLedger } from "@oneshot-gtm/core";
import { runAcceleratorBatchFinder } from "./accelerator-batch.ts";
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
  run: (config: Record<string, unknown>) => Promise<FinderResult>;
}

const ONE_HOUR = 3600 * 1000;

export const TRIGGERS: TriggerSpec[] = [
  {
    name: "show-hn",
    defaultIntervalMs: 6 * ONE_HOUR,
    defaultConfig: { sinceDays: 1, limit: 25, maxCostUsd: 5 },
    run: (cfg) =>
      runShowHnFinder({
        dryRun: false,
        sinceDays: (cfg["sinceDays"] as number) ?? 1,
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
  },
  {
    name: "yc-w26",
    defaultIntervalMs: 24 * ONE_HOUR,
    defaultConfig: { cohort: "yc-w26", limit: 25, maxCostUsd: 5 },
    run: (cfg) =>
      runAcceleratorBatchFinder({
        dryRun: false,
        cohort: (cfg["cohort"] as string) ?? "yc-w26",
        limit: (cfg["limit"] as number) ?? 25,
        maxCostUsd: (cfg["maxCostUsd"] as number) ?? 5,
      }),
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
 * Run every registered trigger that's due. Persists last_polled_at + last_run_summary.
 * Returns one outcome per trigger so the caller can log + decide sleep duration.
 */
export async function runDueTriggers(): Promise<TriggerRunOutcome[]> {
  const ledger = getLedger();
  const now = Date.now();
  const outcomes: TriggerRunOutcome[] = [];

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

    const lastPolledMs = stored?.last_polled_at ? new Date(stored.last_polled_at).getTime() : 0;
    const dueAt = lastPolledMs + intervalMs;
    if (now < dueAt) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: dueAt - now });
      continue;
    }

    try {
      const result = await spec.run(config);
      ledger.updateTriggerLastPoll({ name: spec.name, summary: result });
      outcomes.push({ name: spec.name, fired: true, result, nextDueInMs: intervalMs });
    } catch (err) {
      const message = (err as Error).message ?? "unknown error";
      ledger.updateTriggerLastPoll({
        name: spec.name,
        summary: { error: message, at: new Date().toISOString() },
      });
      outcomes.push({
        name: spec.name,
        fired: true,
        error: message,
        nextDueInMs: intervalMs,
      });
    }
  }
  return outcomes;
}

export function nextSleepMs(outcomes: TriggerRunOutcome[]): number {
  if (outcomes.length === 0) return 60 * 60 * 1000;
  const min = Math.min(...outcomes.map((o) => o.nextDueInMs));
  // Floor at 60s, ceiling at 1h to keep the loop responsive without busy-waiting.
  return Math.max(60_000, Math.min(60 * 60 * 1000, min));
}
