import { getLedger, type TriggerRow } from "@oneshot-gtm/core";
import {
  checkReadiness,
  effectiveIntervalMs,
  fireTriggerNow,
  getTriggerRunningSince,
  isTriggerRunning,
  TRIGGERS,
  type Readiness,
  type TriggerSpec,
} from "@oneshot-gtm/find";
import type { RunTriggerResult, TriggerView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

export function toView(
  name: string,
  defaultIntervalMs: number,
  row: TriggerRow | null,
  spec: TriggerSpec | null,
): TriggerView {
  let lastSummary: unknown = null;
  if (row?.last_run_summary) {
    try {
      lastSummary = JSON.parse(row.last_run_summary);
    } catch {
      lastSummary = row.last_run_summary;
    }
  }
  let config: Record<string, unknown> | null = null;
  if (row?.config_json) {
    try {
      const parsed = JSON.parse(row.config_json) as unknown;
      if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
    } catch {
      config = null;
    }
  }
  const defaultEnabled = spec ? spec.enabledByDefault !== false : true;
  const intervalMs = spec ? effectiveIntervalMs(spec, config) : defaultIntervalMs;
  const runningSinceMs = getTriggerRunningSince(name);
  // Explicit annotation keeps the discriminated-union narrowing intact
  // (the literal { ready: true } branch would otherwise widen the union).
  const readiness: Readiness = spec
    ? checkReadiness(spec, config ?? spec.defaultConfig)
    : { ready: true };
  return {
    name,
    enabled: row ? Boolean(row.enabled) : defaultEnabled,
    defaultIntervalMs,
    intervalMs,
    config,
    defaultConfig: spec ? spec.defaultConfig : null,
    lastPolledAt: row?.last_polled_at ?? null,
    lastRunSummary: lastSummary,
    running: isTriggerRunning(name),
    runningSince: runningSinceMs != null ? new Date(runningSinceMs).toISOString() : null,
    ready: readiness.ready,
    notReadyReason: readiness.ready ? null : readiness.reason,
  };
}

export function listTriggersRoute(req: Request): Response {
  const ledger = getLedger();
  const rows = ledger.listTriggers();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const views: TriggerView[] = [];
  for (const spec of TRIGGERS) {
    seen.add(spec.name);
    views.push(toView(spec.name, spec.defaultIntervalMs, byName.get(spec.name) ?? null, spec));
  }
  // Surface any historical triggers stored in the ledger that no longer exist
  // in the registry (e.g. a deprecated cohort) so the founder can disable them.
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    views.push(toView(row.name, 24 * 3600 * 1000, row, null));
  }
  return jsonResponse({ triggers: views }, 200, req);
}

export async function setTriggerEnabledRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params["name"];
  if (!name) return jsonResponse({ error: "name required" }, 400, req);
  let body: { enabled?: boolean } = {};
  try {
    body = (await req.json()) as { enabled?: boolean };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof body.enabled !== "boolean") {
    return jsonResponse({ error: "enabled (boolean) required" }, 400, req);
  }
  const ledger = getLedger();
  const stored = ledger.getTrigger(name);
  const spec = TRIGGERS.find((t) => t.name === name) ?? null;
  // Readiness gate: block *enabling* an unready trigger so the scheduler
  // doesn't sit in a loop skipping it every tick. Disabling is always allowed.
  if (body.enabled && spec) {
    const config = stored?.config_json
      ? (JSON.parse(stored.config_json) as Record<string, unknown>)
      : spec.defaultConfig;
    const readiness = checkReadiness(spec, config);
    if (!readiness.ready) {
      return jsonResponse(
        {
          error: `trigger '${name}' not ready: ${readiness.reason}`,
          name,
          reason: readiness.reason,
        },
        409,
        req,
      );
    }
  }
  if (!stored) {
    if (!spec) return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
    ledger.upsertTrigger({
      name,
      configJson: JSON.stringify(spec.defaultConfig),
      enabled: body.enabled,
    });
  } else {
    ledger.setTriggerEnabled(name, body.enabled);
  }
  return jsonResponse({ ok: true, name, enabled: body.enabled }, 200, req);
}

export async function setTriggerConfigRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params["name"];
  if (!name) return jsonResponse({ error: "name required" }, 400, req);
  let body: { config?: unknown } = {};
  try {
    body = (await req.json()) as { config?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!body.config || typeof body.config !== "object") {
    return jsonResponse({ error: "config (object) required" }, 400, req);
  }
  const ledger = getLedger();
  const stored = ledger.getTrigger(name);
  if (!stored) {
    const spec = TRIGGERS.find((t) => t.name === name);
    if (!spec) return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
    ledger.upsertTrigger({
      name,
      configJson: JSON.stringify(body.config),
      enabled: true,
    });
  } else {
    ledger.setTriggerConfig(name, JSON.stringify(body.config));
  }
  return jsonResponse({ ok: true, name }, 200, req);
}

/** Fire-and-forget: 202 on kick-off, 409 if already running. UI polls `GET /api/triggers`. */
export function runTriggerRoute(req: Request, params: Record<string, string>): Response {
  const name = params["name"];
  if (!name) return jsonResponse({ error: "name required" }, 400, req);
  if (!TRIGGERS.some((t) => t.name === name)) {
    return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
  }
  try {
    fireTriggerNow(name);
  } catch (err) {
    const message = (err as Error).message ?? "failed to fire";
    if (message.includes("already running")) {
      return jsonResponse({ error: message, name, running: true }, 409, req);
    }
    if (message.startsWith("not ready:")) {
      const reason = message.slice("not ready:".length).trim();
      return jsonResponse({ error: message, name, reason, ready: false }, 409, req);
    }
    return jsonResponse({ error: message }, 500, req);
  }
  const view: RunTriggerResult = {
    name,
    fired: true,
    pending: true,
    result: null,
    error: null,
  };
  return jsonResponse(view, 202, req);
}
