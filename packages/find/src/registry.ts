import { getLedger } from "@oneshot-gtm/core";
import { runAcceleratorBatchFinder } from "./accelerator-batch.ts";
import { runPostFundingFinder } from "./post-funding.ts";
import { runShowHnFinder } from "./show-hn.ts";
import type { FinderResult } from "./_types.ts";

export interface TriggerSpec {
  name: string;
  defaultIntervalMs: number;
  defaultConfig: Record<string, unknown>;
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
];

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
    // Initialize on first sight.
    if (!stored) {
      ledger.upsertTrigger({
        name: spec.name,
        configJson: JSON.stringify(spec.defaultConfig),
        enabled: true,
      });
    }

    const enabled = stored ? Boolean(stored.enabled) : true;
    if (!enabled) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: spec.defaultIntervalMs });
      continue;
    }

    const lastPolledMs = stored?.last_polled_at ? new Date(stored.last_polled_at).getTime() : 0;
    const dueAt = lastPolledMs + spec.defaultIntervalMs;
    if (now < dueAt) {
      outcomes.push({ name: spec.name, fired: false, nextDueInMs: dueAt - now });
      continue;
    }

    const config = stored?.config_json
      ? (JSON.parse(stored.config_json) as Record<string, unknown>)
      : spec.defaultConfig;

    try {
      const result = await spec.run(config);
      ledger.updateTriggerLastPoll({ name: spec.name, summary: result });
      outcomes.push({ name: spec.name, fired: true, result, nextDueInMs: spec.defaultIntervalMs });
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
        nextDueInMs: spec.defaultIntervalMs,
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
