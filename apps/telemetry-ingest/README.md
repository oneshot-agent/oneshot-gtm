# oneshot-gtm telemetry ingest

First-party receiver for the anonymous, opt-out CLI telemetry described in the
repo-root [`TELEMETRY.md`](../../TELEMETRY.md). The CLI POSTs one summary event
per invocation here; the service validates it against a strict whitelist and
streams a row into BigQuery.

It deploys to **Cloud Run** as a single production service (`us-central1` by
default). The target GCP project comes from your active `gcloud config` (or
`PROJECT=<id>`) — no project id is baked into the repo. The client never talks
to a third-party analytics vendor — only to this endpoint.

## Endpoints

- `GET /` — health check (Cloud Run liveness).
- `POST /v1/cli` — ingest one event. Returns `204` on accept, `400` on a bad
  payload. Storage failures are logged and still `204` (the client is
  fire-and-forget).

## Run locally

```bash
# in-memory sink, no GCP creds needed
TELEMETRY_SINK=local PORT=8080 bun run src/index.ts

# point the CLI at it
ONESHOT_GTM_TELEMETRY_URL=http://localhost:8080/v1/cli oneshot-gtm doctor
```

## Provision + deploy (run by a maintainer with gcloud/bq access)

The deploy/provision scripts (`bq-setup.sh`, `deploy.sh`, BigQuery schema) live
in `ops/telemetry-ingest/`, which is **gitignored** — they describe first-party
cloud topology and are kept out of this public repo. They build/deploy the app
in this directory.

```bash
cd ops/telemetry-ingest

# 1. one-time: create dataset telemetry + table cli_events (day-partitioned)
./bq-setup.sh

# 2. deploy the production service
./deploy.sh

# 3. one-time (only if the runtime SA lacks BigQuery write access):
#    the deploy script prints the exact grant command
```

After deploy, set `DEFAULT_TELEMETRY_URL` in `packages/core/src/telemetry.ts`
to a **stable custom domain** you map onto the service (e.g.
`https://telemetry.yourdomain.com/v1/cli`) — prefer a domain you own over the
raw `*.run.app` host so the public client doesn't pin a Cloud Run revision or
leak the project number. For ad-hoc testing, point the CLI at the service URL
via `ONESHOT_GTM_TELEMETRY_URL`.

## Verify rows land

```bash
bq query --use_legacy_sql=false \
  'SELECT command, outcome, duration_ms, version, ingest_ts
   FROM telemetry.cli_events ORDER BY ingest_ts DESC LIMIT 10'
```

## Environment

| Var              | Default      | Purpose                                  |
| ---------------- | ------------ | ---------------------------------------- |
| `PORT`           | `8080`       | Cloud Run injects this.                  |
| `TELEMETRY_SINK` | `bigquery`   | Set `local` for the in-memory dev sink.  |
| `GCP_PROJECT`    | (ADC)        | BigQuery project override.               |
| `BQ_DATASET`     | `telemetry`  | Dataset name.                            |
| `BQ_TABLE`       | `cli_events` | Table name.                              |
