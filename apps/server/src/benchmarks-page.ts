import { readPublicBenchmarks, type PublicBenchmarks } from "./api/benchmarks.ts";

const count = (value: number) => value.toLocaleString("en-US");

/** Only validated numbers and fixed copy enter this document; no workspace shell. */
export function renderBenchmarksPage(data: PublicBenchmarks | null): string {
  const content = data
    ? `${data.cohortSize === 0 ? "<p>No benchmark samples yet.</p>" : ""}
      <dl>
        <dt>Cohort sample size</dt><dd>${count(data.cohortSize)} installs</dd>
        <dt>Commands run</dt><dd>${count(data.cohort.commandsRun)} commands</dd>
        <dt>Success rate</dt><dd>${data.cohort.successRate === null ? "Not available — no commands sampled" : `${(data.cohort.successRate * 100).toFixed(1)}%`}</dd>
        <dt>Median duration</dt><dd>${data.cohort.medianDurationMs === null ? "Not available — no commands sampled" : `${count(data.cohort.medianDurationMs)} ms`}</dd>
      </dl>`
    : '<p role="status">Benchmark data is unavailable. Try again later.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Public benchmarks · oneshot-gtm</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; line-height: 1.6; }
    main { max-width: 48rem; padding: 3rem 1.5rem; margin: auto; }
    h1 { line-height: 1.2; }
    dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; padding-block: 1rem; border-block: 1px solid; }
    dd { margin: 0; font-variant-numeric: tabular-nums; }
    a { color: inherit; }
    @media (max-width: 30rem) { dl { grid-template-columns: 1fr; gap: .4rem; } dd { margin-bottom: 1rem; } }
  </style>
</head>
<body><main>
  <p>oneshot-gtm · Telemetry</p>
  <h1>Public benchmarks</h1>
  <p>Aggregate command usage from installs sharing anonymous telemetry.</p>
  ${content}
  <p>Success rate is shown as a percentage; median command duration is in milliseconds (ms).
    These are the telemetry service’s cohort aggregates, not outreach conversion rates.</p>
  <p>The service supplies the cohort’s install count and commands-run measure.
    It does not supply separate sample counts for success rate or duration, or a reporting window.</p>
  <p>No individual install comparison, raw events or personal identifiers are shown.</p>
  <p><a href="/benchmarks">Refresh benchmarks</a> · <a href="/api/benchmarks">Aggregate JSON</a></p>
</main></body>
</html>`;
}

export async function benchmarksPage(): Promise<Response> {
  const data = await readPublicBenchmarks();
  return new Response(renderBenchmarksPage(data), {
    status: data ? 200 : 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
