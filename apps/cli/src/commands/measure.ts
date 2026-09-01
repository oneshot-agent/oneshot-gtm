import { loadConfig, shouldSendTelemetry, telemetryUrl } from "@oneshot-gtm/core";
import { emitJson, header, note, setJsonMode, warn } from "../output.ts";

export interface BenchmarkMetrics {
  commandsRun: number;
  successRate: number;
  medianDurationMs: number;
}

export interface BenchmarkAggregate {
  cohortSize: number;
  local: BenchmarkMetrics;
  cohort: BenchmarkMetrics;
}

type BenchmarkStatus = "ok" | "opted-out" | "unavailable";

/** The aggregate reader lives beside the telemetry ingest route. */
export function benchmarkUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ONESHOT_GTM_BENCHMARK_URL"];
  if (override !== undefined) return override.trim();
  const ingest = telemetryUrl(env);
  if (!ingest) return "";
  try {
    const url = new URL(ingest);
    url.pathname = url.pathname.replace(/\/cli\/?$/, "/benchmark");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function metrics(value: unknown): BenchmarkMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !finiteNonNegative(row["commandsRun"]) ||
    !finiteNonNegative(row["successRate"]) ||
    row["successRate"] > 1 ||
    !finiteNonNegative(row["medianDurationMs"])
  ) {
    return null;
  }
  return {
    commandsRun: row["commandsRun"],
    successRate: row["successRate"],
    medianDurationMs: row["medianDurationMs"],
  };
}

/** Validate the public aggregate response before using it in terminal output. */
export function parseBenchmarkAggregate(value: unknown): BenchmarkAggregate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const local = metrics(row["local"]);
  const cohort = metrics(row["cohort"]);
  if (!Number.isInteger(row["cohortSize"]) || !finiteNonNegative(row["cohortSize"])) return null;
  if (!local || !cohort || row["cohortSize"] === 0) return null;
  return { cohortSize: row["cohortSize"], local, cohort };
}

function renderMetric(label: string, local: string, cohort: string): void {
  note(`  ${label.padEnd(20)} ${local.padStart(10)}   cohort ${cohort.padStart(10)}`);
}

function renderBenchmark(aggregate: BenchmarkAggregate): void {
  header("measure · benchmark");
  note(`Your install vs ${aggregate.cohortSize.toLocaleString()} opted-in installs\n`);
  renderMetric(
    "commands run",
    aggregate.local.commandsRun.toLocaleString(),
    aggregate.cohort.commandsRun.toLocaleString(),
  );
  renderMetric(
    "success rate",
    `${(aggregate.local.successRate * 100).toFixed(1)}%`,
    `${(aggregate.cohort.successRate * 100).toFixed(1)}%`,
  );
  renderMetric(
    "median duration",
    `${Math.round(aggregate.local.medianDurationMs)} ms`,
    `${Math.round(aggregate.cohort.medianDurationMs)} ms`,
  );
}

function emitBenchmarkJson(status: BenchmarkStatus, aggregate?: BenchmarkAggregate): void {
  emitJson({
    command: "measure benchmark",
    status,
    ...(aggregate ? aggregate : {}),
  });
}

export async function commandMeasureBenchmark(
  opts: { json?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (opts.json) setJsonMode(true);
  const cfg = loadConfig();

  if (!shouldSendTelemetry(cfg, env)) {
    if (opts.json) emitBenchmarkJson("opted-out");
    else {
      header("measure · benchmark");
      note(
        "Telemetry sharing is disabled, so this install is not included in the opt-in cohort. Enable it with `oneshot-gtm config telemetry on` to view benchmarks.",
      );
    }
    return;
  }

  const endpoint = benchmarkUrl(env);
  let aggregate: BenchmarkAggregate | null = null;
  try {
    if (endpoint && cfg.clientId) {
      const url = new URL(endpoint);
      url.searchParams.set("anonymous_machine_id", cfg.clientId);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (response.ok) aggregate = parseBenchmarkAggregate(await response.json());
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } catch {
    // The comparison is informational; a bad aggregate must not crash the CLI.
  }

  if (!aggregate) {
    if (opts.json) emitBenchmarkJson("unavailable");
    else {
      header("measure · benchmark");
      warn("Benchmark data is unavailable. The cohort may still be warming up; try again later.");
    }
    return;
  }

  if (opts.json) emitBenchmarkJson("ok", aggregate);
  else renderBenchmark(aggregate);
}
