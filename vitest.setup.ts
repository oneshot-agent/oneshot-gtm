// Per-test-file data-dir isolation.
//
// `@oneshot-gtm/core`'s config.ts resolves its data dir (config.json, .env,
// ledger.sqlite, events.jsonl, gmail-tokens.json) from `ONESHOT_GTM_HOME`,
// falling back to ~/.oneshot-gtm. Without this, any test that doesn't fully
// mock the ledger / logEvent / config writes into the developer's REAL data
// dir — e.g. fake `runs` rows and `cadence.batch.failed: "boom"` events leaking
// from the cadence batch-route test.
//
// vitest runs setupFiles before each test file's module graph is imported, so
// pointing the env at a fresh temp dir here lands before config.ts is first
// evaluated. This file imports only node built-ins on purpose — importing
// anything that pulls in config.ts would evaluate it before the env is set.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oneshot-gtm-test-"));
process.env["ONESHOT_GTM_HOME"] = dir;

// Hard-disable distribution telemetry for the whole suite. Otherwise any test
// that drives a server route / scheduler tick / CLI dispatch reaches
// reportTelemetryEvent, which (telemetry defaults on) fires a real POST to the
// production endpoint — synthetic events leaking into prod BigQuery, plus per-
// test latency. The dedicated telemetry tests manage this var themselves
// (explicit env args, or delete/set process.env per case), so their "enabled"
// assertions are unaffected.
process.env["ONESHOT_GTM_TELEMETRY"] = "0";

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort; the OS reaps tmpdir anyway
  }
});
