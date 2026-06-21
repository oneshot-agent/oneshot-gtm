import { validateEvent } from "./schema.ts";
import type { Sink } from "./sink.ts";

/** Path the CLI posts to (see DEFAULT_TELEMETRY_URL in packages/core). */
export const INGEST_PATH = "/v1/cli";

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Runtime-agnostic request handler (web-standard Request/Response, so it runs
 * under Bun, Node, or any edge runtime and is trivially unit-testable).
 *
 * - GET  /            → health check (Cloud Run liveness)
 * - POST {INGEST_PATH}→ validate + insert one event
 *
 * Never throws: a sink failure is logged and swallowed with a 204 so a
 * transient BigQuery hiccup doesn't turn into client-visible 5xx retries
 * (the client is fire-and-forget anyway).
 */
export async function handleTelemetry(req: Request, sink: Sink, now: () => string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/") {
    return json(200, { ok: true, service: "oneshot-gtm-telemetry-ingest" });
  }

  if (url.pathname !== INGEST_PATH) return json(404, { error: "not found" });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }

  const result = validateEvent(body, now());
  if (!result.ok) return json(400, { error: result.reason });

  try {
    await sink.insert(result.row);
    if (process.env["INGEST_DEBUG"]) {
      console.log("ingest:", result.row.command, result.row.outcome, `${result.row.duration_ms}ms`);
    }
  } catch (err) {
    // Don't surface storage errors to the fire-and-forget client; record for
    // our own logs (Cloud Run captures stderr) and ack.
    console.error("telemetry insert failed:", (err as Error).message);
  }
  return new Response(null, { status: 204 });
}
