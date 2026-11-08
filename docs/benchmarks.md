# Public benchmarks

Start the local server from the repo root:

```bash
bun install --frozen-lockfile
bun run ui -- --no-browser
```

Open <http://127.0.0.1:3030/benchmarks> (or your workspace’s port). The server renders
this page directly, including in Vite development mode; no dashboard build, JavaScript,
API key or telemetry opt-in is needed to view it. The server retains its loopback bind
and host guard. This change does not publish a site or expose the private dashboard.

## Aggregate contract

The source is the same `/v1/benchmark` endpoint used by `oneshot-gtm measure benchmark`.
The existing client contract lives in `packages/core/src/benchmark.ts`; the receiver
and its aggregation queries are outside this repository. The page preserves the
service’s cohort values rather than computing different aggregations from local events.

`GET /api/benchmarks` returns only these fields:

| Field                     | Meaning / unit                                                     |
| ------------------------- | ------------------------------------------------------------------ |
| `cohortSize`              | Available cohort sample count, in installs                         |
| `cohort.commandsRun`      | Service-provided commands-run measure, in commands                 |
| `cohort.successRate`      | Service-provided success fraction (0–1), displayed as a percentage |
| `cohort.medianDurationMs` | Service-provided median command duration, in milliseconds          |

The contract does not specify a reporting window, separate rate/duration sample
counts, or whether commands-run is normalized per install. The page makes none of
those claims. These are command execution benchmarks, not reply or conversion rates.
An empty cohort shows “No benchmark samples yet.” Zero commands produces JSON `null`
for success rate and duration, displayed as “Not available — no commands sampled.”
An unavailable endpoint or invalid aggregate returns HTTP 503 with a generic message,
not invented zeroes. Both JSON and HTML are uncached so refreshing retries the source.

The public fetch sends no install UUID, request query, cookies or authorization.
Only the allowlisted numeric cohort fields reach the browser; `local`, raw events,
identifiers and extra fields are discarded. Reading does not collect telemetry.

## Local fixture access

The default URL is derived from `ONESHOT_GTM_TELEMETRY_URL` by replacing `/cli` with
`/benchmark`. `ONESHOT_GTM_BENCHMARK_URL` overrides it; an empty value disables fetching.
Public reads discard query parameters and URL credentials even on an override.

For a deterministic preview, run this in a separate terminal from the repo root:

```bash
bun -e 'Bun.serve({ hostname: "127.0.0.1", port: 4031, fetch: () => new Response(Bun.file("apps/server/__tests__/fixtures/benchmarks/populated.json"), { headers: { "content-type": "application/json" } }) })'
```

Then launch the server with the override (no `.env` edit needed):

```bash
ONESHOT_GTM_BENCHMARK_URL=http://127.0.0.1:4031/v1/benchmark bun run ui -- --no-browser
```

Use `empty.json` or `zero-denominator.json` in place of `populated.json` to see those
states. The fixtures are synthetic; the extra private-looking fields in the populated
fixture deliberately verify that the public projection excludes them.

## Publishing

Publishing is outside this feature. Before release, the operator should verify that
the configured aggregate service supports anonymous GET without an install UUID and
returns the documented cohort fields, then check the deployed page and JSON allowlist.
The live default URL returned HTTP 404 during implementation; local fixture checks do
not demonstrate production endpoint readiness. Do not publish the local workspace
server as a way to publish this page.
