import {
  loadConfig,
  shouldSendTelemetry,
  benchmarkUrl,
  parseBenchmarkAggregate,
  readBenchmarkJson,
  type BenchmarkAggregate,
} from "@oneshot-gtm/core";
import { emitJson, header, note, setJsonMode, warn } from "../output.ts";

export { benchmarkUrl, parseBenchmarkAggregate } from "@oneshot-gtm/core";
export type { BenchmarkAggregate, BenchmarkMetrics } from "@oneshot-gtm/core";

type BenchmarkStatus = "ok" | "opted-out" | "unavailable";
const BENCHMARK_TIMEOUT_MS = 10000;

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
      const timeoutId = setTimeout(() => controller.abort(), BENCHMARK_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (response.ok) aggregate = parseBenchmarkAggregate(await readBenchmarkJson(response));
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
