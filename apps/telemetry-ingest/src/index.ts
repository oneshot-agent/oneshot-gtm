import { handleTelemetry } from "./handler.ts";
import { sinkFromEnv } from "./sink.ts";

// Cloud Run injects PORT (default 8080). The sink is chosen once at boot.
const port = Number.parseInt(process.env["PORT"] ?? "8080", 10);
const sink = sinkFromEnv();
const now = () => new Date().toISOString();

Bun.serve({
  port,
  fetch: (req) => handleTelemetry(req, sink, now),
});

console.log(
  `oneshot-gtm telemetry ingest listening on :${port} (sink=${process.env["TELEMETRY_SINK"] ?? "bigquery"})`,
);
