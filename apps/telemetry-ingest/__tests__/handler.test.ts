import { describe, expect, it } from "vitest";
import { handleTelemetry, INGEST_PATH } from "../src/handler.ts";
import { BigQuerySink, MemorySink, sinkFromEnv } from "../src/sink.ts";
import { validateEvent } from "../src/schema.ts";

const NOW = "2026-06-21T00:00:00.000Z";
const URL = `http://ingest.local${INGEST_PATH}`;

function post(body: unknown): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = {
  command: "motion show-hn",
  flags: ["dry-run"],
  outcome: "ok",
  duration_ms: 42,
  version: "0.6.0",
  os: "darwin",
  bun_version: "1.3.13",
  anonymous_machine_id: "cid-1",
  llm_provider: "openrouter",
};

describe("handleTelemetry — routing", () => {
  it("GET / is a health check", async () => {
    const res = await handleTelemetry(
      new Request("http://ingest.local/"),
      new MemorySink(),
      () => NOW,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("unknown path is 404", async () => {
    const res = await handleTelemetry(
      new Request("http://ingest.local/nope"),
      new MemorySink(),
      () => NOW,
    );
    expect(res.status).toBe(404);
  });

  it("non-POST to the ingest path is 405", async () => {
    const res = await handleTelemetry(
      new Request(URL, { method: "PUT" }),
      new MemorySink(),
      () => NOW,
    );
    expect(res.status).toBe(405);
  });

  it("invalid JSON body is 400", async () => {
    const res = await handleTelemetry(post("{not json"), new MemorySink(), () => NOW);
    expect(res.status).toBe(400);
  });
});

describe("handleTelemetry — ingest", () => {
  it("accepts a valid payload, records one row, returns 204", async () => {
    const sink = new MemorySink();
    const res = await handleTelemetry(post(VALID), sink, () => NOW);
    expect(res.status).toBe(204);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      command: "motion show-hn",
      flags: ["dry-run"],
      outcome: "ok",
      duration_ms: 42,
      anonymous_machine_id: "cid-1",
      ingest_ts: NOW,
    });
  });

  it("strips fields outside the whitelist", async () => {
    const sink = new MemorySink();
    await handleTelemetry(post({ ...VALID, SNEAKY: "x", email: "a@b.com" }), sink, () => NOW);
    expect(sink.rows[0]).not.toHaveProperty("SNEAKY");
    expect(sink.rows[0]).not.toHaveProperty("email");
  });

  it("rejects a missing command with 400 and stores nothing", async () => {
    const sink = new MemorySink();
    const res = await handleTelemetry(post({ outcome: "ok" }), sink, () => NOW);
    expect(res.status).toBe(400);
    expect(sink.rows).toHaveLength(0);
  });

  it("rejects an invalid outcome with 400", async () => {
    const sink = new MemorySink();
    const res = await handleTelemetry(post({ command: "x", outcome: "boom" }), sink, () => NOW);
    expect(res.status).toBe(400);
  });

  it("still ACKs (204) when the sink throws — fire-and-forget client must not retry", async () => {
    const failing = {
      async insert() {
        throw new Error("bq down");
      },
    };
    const res = await handleTelemetry(post(VALID), failing, () => NOW);
    expect(res.status).toBe(204);
  });
});

describe("sinkFromEnv — sink selection", () => {
  it("returns the in-memory sink when TELEMETRY_SINK=local", () => {
    expect(sinkFromEnv({ TELEMETRY_SINK: "local" })).toBeInstanceOf(MemorySink);
    expect(sinkFromEnv({ TELEMETRY_SINK: "LOCAL" })).toBeInstanceOf(MemorySink);
  });

  it("returns the BigQuery sink by default (no creds touched until first insert)", () => {
    // Construction is lazy — selecting it must not require GCP credentials.
    expect(sinkFromEnv({ BQ_DATASET: "telemetry", BQ_TABLE: "cli_events" })).toBeInstanceOf(
      BigQuerySink,
    );
  });
});

describe("validateEvent — caps + coercion", () => {
  it("rejects a non-object body", () => {
    expect(validateEvent(null, NOW).ok).toBe(false);
    expect(validateEvent("nope", NOW).ok).toBe(false);
    expect(validateEvent(42, NOW).ok).toBe(false);
  });

  it("rejects an empty / non-string command", () => {
    expect(validateEvent({ command: "", outcome: "ok" }, NOW).ok).toBe(false);
    expect(validateEvent({ command: 123, outcome: "ok" }, NOW).ok).toBe(false);
  });

  it.each(["ok", "error", "lint-blocked"])("accepts the valid outcome %s", (outcome) => {
    expect(validateEvent({ command: "x", outcome }, NOW).ok).toBe(true);
  });

  it("stamps ingest_ts from the supplied clock", () => {
    const r = validateEvent({ command: "x", outcome: "ok" }, NOW);
    expect(r.ok && r.row.ingest_ts).toBe(NOW);
  });

  it("defaults a null anonymous_machine_id and missing optional strings to empty", () => {
    const r = validateEvent({ command: "x", outcome: "ok" }, NOW);
    expect(r.ok && r.row.anonymous_machine_id).toBeNull();
    expect(r.ok && r.row.version).toBe("");
    expect(r.ok && r.row.llm_provider).toBe("");
  });

  it("caps flags count and element length", () => {
    const flags = Array.from({ length: 50 }, (_, i) => "f".repeat(100) + i);
    const r = validateEvent({ command: "x", outcome: "ok", flags }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.flags.length).toBeLessThanOrEqual(32);
      expect(r.row.flags.every((f) => f.length <= 60)).toBe(true);
    }
  });

  it("coerces a non-numeric duration to 0 and clamps absurd durations", () => {
    const bad = validateEvent({ command: "x", outcome: "ok", duration_ms: "huge" }, NOW);
    expect(bad.ok && bad.row.duration_ms).toBe(0);
    const big = validateEvent({ command: "x", outcome: "ok", duration_ms: 1e15 }, NOW);
    expect(big.ok && big.row.duration_ms).toBe(24 * 60 * 60 * 1000);
  });

  it("drops non-string flags", () => {
    const r = validateEvent({ command: "x", outcome: "ok", flags: ["a", 1, null, "b"] }, NOW);
    expect(r.ok && r.row.flags).toEqual(["a", "b"]);
  });
});
