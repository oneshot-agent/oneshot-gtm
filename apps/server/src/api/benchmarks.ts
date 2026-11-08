import { benchmarkUrl, readBenchmarkJson, type BenchmarkMetrics } from "@oneshot-gtm/core";

/** Public projection of the existing /v1/benchmark cohort. Never include `local`. */
export interface PublicBenchmarks {
  cohortSize: number;
  cohort: Omit<BenchmarkMetrics, "successRate" | "medianDurationMs"> & {
    successRate: number | null;
    medianDurationMs: number | null;
  };
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Construct an allowlist, rather than forwarding even a validated upstream object. */
export function publicBenchmarks(value: unknown): PublicBenchmarks | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!nonNegative(row["cohortSize"]) || !Number.isSafeInteger(row["cohortSize"])) return null;
  const source = row["cohort"];
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const cohort = source as Record<string, unknown>;
  const commandsRun = cohort["commandsRun"];
  if (!nonNegative(commandsRun)) return null;
  // No samples: a service may encode undefined rates as null or zero. Neither
  // represents a measured success rate or duration, so the public view uses null.
  if (row["cohortSize"] === 0 || commandsRun === 0) {
    if (row["cohortSize"] === 0 && commandsRun !== 0) return null;
    return {
      cohortSize: row["cohortSize"],
      cohort: { commandsRun, successRate: null, medianDurationMs: null },
    };
  }
  const successRate = cohort["successRate"];
  const medianDurationMs = cohort["medianDurationMs"];
  if (!nonNegative(successRate) || successRate > 1 || !nonNegative(medianDurationMs)) return null;
  return { cohortSize: row["cohortSize"], cohort: { commandsRun, successRate, medianDurationMs } };
}

export async function readPublicBenchmarks(): Promise<PublicBenchmarks | null> {
  try {
    const endpoint = benchmarkUrl();
    if (!endpoint) return null;
    const url = new URL(endpoint);
    // Public reads never send a machine id, browser query, cookies or credentials.
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) return null;
    return publicBenchmarks(await readBenchmarkJson(response));
  } catch {
    // Do not leak upstream error bodies, URLs or local configuration.
    return null;
  }
}

export async function benchmarksRoute(): Promise<Response> {
  const data = await readPublicBenchmarks();
  return Response.json(data ?? { error: "Benchmark data is unavailable. Try again later." }, {
    status: data ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
