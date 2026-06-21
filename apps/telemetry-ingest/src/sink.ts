import type { TelemetryRow } from "./schema.ts";

/**
 * Where validated rows go. Two implementations: BigQuery (production) and an
 * in-memory list (local dev + tests). The handler depends only on this
 * interface so the wire/validation path can be exercised without GCP creds.
 */
export interface Sink {
  insert(row: TelemetryRow): Promise<void>;
}

/** Holds rows in process memory. Used by `TELEMETRY_SINK=local` and by tests. */
export class MemorySink implements Sink {
  readonly rows: TelemetryRow[] = [];
  async insert(row: TelemetryRow): Promise<void> {
    this.rows.push(row);
  }
}

/**
 * Streams one row per event into BigQuery via tabledata.insertAll. The
 * `@google-cloud/bigquery` client is imported lazily ON FIRST INSERT — not in
 * the constructor. An eager async IIFE in the constructor would be a floating
 * promise: if the dynamic import or `new BigQuery()` rejected (missing dep, bad
 * ADC) it would surface as an unhandledRejection and could crash the container
 * at boot, before any request. Initializing inside `insert` means the init
 * promise is always awaited where its rejection is handled (by the handler's
 * catch → 204).
 */
export class BigQuerySink implements Sink {
  private table?: Promise<{ insert(rows: unknown[]): Promise<unknown> }>;

  constructor(private readonly opts: { projectId?: string; dataset: string; table: string }) {}

  private getTable(): Promise<{ insert(rows: unknown[]): Promise<unknown> }> {
    return (this.table ??= (async () => {
      const { BigQuery } = await import("@google-cloud/bigquery");
      // On Cloud Run, credentials + projectId come from the runtime service
      // account via ADC — no key file. projectId is optional override.
      const bq = new BigQuery(this.opts.projectId ? { projectId: this.opts.projectId } : {});
      return bq.dataset(this.opts.dataset).table(this.opts.table);
    })());
  }

  async insert(row: TelemetryRow): Promise<void> {
    const table = await this.getTable();
    await table.insert([row]);
  }
}

/**
 * Pick a sink from the environment. Defaults to BigQuery; set
 * `TELEMETRY_SINK=local` for dev/tests. Dataset/table are overridable so the
 * stg and prod services can point at the same or distinct tables.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): Sink {
  if ((env["TELEMETRY_SINK"] ?? "").toLowerCase() === "local") {
    return new MemorySink();
  }
  return new BigQuerySink({
    projectId: env["GCP_PROJECT"] || env["GOOGLE_CLOUD_PROJECT"] || undefined,
    dataset: env["BQ_DATASET"] || "telemetry",
    table: env["BQ_TABLE"] || "cli_events",
  });
}
