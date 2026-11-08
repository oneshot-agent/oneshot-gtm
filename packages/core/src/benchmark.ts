import { telemetryUrl } from "./telemetry.ts";

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

const MAX_BENCHMARK_RESPONSE_BYTES = 512 * 1024;

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

export async function readBenchmarkJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > MAX_BENCHMARK_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  let json = "";
  for (const chunk of chunks) json += decoder.decode(chunk, { stream: true });
  json += decoder.decode();
  return JSON.parse(json);
}
