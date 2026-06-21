/**
 * The ingest contract — intentionally a SEPARATE definition from the client's
 * `TelemetryPayload` (packages/core/src/telemetry.ts). This is the trust
 * boundary: the receiver accepts unauthenticated public traffic, so it
 * validates and whitelists rather than trusting the shape. Keeping the field
 * list here in lockstep with TELEMETRY.md (and the client) is deliberate
 * duplication, not an abstraction to share.
 */

export const OUTCOMES = ["ok", "error", "lint-blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Caps — defense against a malformed or hostile client stuffing the table. */
const MAX_STR = 120;
const MAX_FLAGS = 32;
const MAX_FLAG_LEN = 60;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // a CLI run over a day is noise

/** One validated row, ready for insert. `ingest_ts` is stamped server-side. */
export interface TelemetryRow {
  command: string;
  flags: string[];
  outcome: Outcome;
  duration_ms: number;
  version: string;
  os: string;
  bun_version: string;
  anonymous_machine_id: string | null;
  llm_provider: string;
  ingest_ts: string;
}

function clampStr(v: unknown, max = MAX_STR): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Validate + whitelist an incoming body into a row, or return an error reason.
 * Strips every field not on the whitelist. Requires only the two load-bearing
 * fields (`command`, `outcome`); everything else is best-effort so a newer or
 * older client never gets rejected over a peripheral field.
 */
export function validateEvent(
  body: unknown,
  now: string,
): { ok: true; row: TelemetryRow } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "body is not an object" };
  const b = body as Record<string, unknown>;

  const command = clampStr(b["command"]);
  if (!command) return { ok: false, reason: "missing command" };

  const outcome = b["outcome"];
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, reason: "invalid outcome" };
  }

  const rawFlags = Array.isArray(b["flags"]) ? b["flags"] : [];
  const flags = rawFlags
    .filter((f): f is string => typeof f === "string")
    .slice(0, MAX_FLAGS)
    .map((f) => f.slice(0, MAX_FLAG_LEN));

  const rawDuration = b["duration_ms"];
  const duration_ms =
    typeof rawDuration === "number" && Number.isFinite(rawDuration)
      ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(rawDuration)))
      : 0;

  const machineId = b["anonymous_machine_id"];
  const anonymous_machine_id = typeof machineId === "string" ? machineId.slice(0, MAX_STR) : null;

  return {
    ok: true,
    row: {
      command,
      flags,
      outcome: outcome as Outcome,
      duration_ms,
      version: clampStr(b["version"]),
      os: clampStr(b["os"]),
      bun_version: clampStr(b["bun_version"]),
      anonymous_machine_id,
      llm_provider: clampStr(b["llm_provider"]),
      ingest_ts: now,
    },
  };
}
