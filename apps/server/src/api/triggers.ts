import { getLedger, type TriggerRow } from "@oneshot-gtm/core";
import { TRIGGERS } from "@oneshot-gtm/find";
import type { TriggerView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function toView(name: string, defaultIntervalMs: number, row: TriggerRow | null): TriggerView {
  let lastSummary: unknown = null;
  if (row?.last_run_summary) {
    try {
      lastSummary = JSON.parse(row.last_run_summary);
    } catch {
      lastSummary = row.last_run_summary;
    }
  }
  let config: unknown = null;
  if (row?.config_json) {
    try {
      config = JSON.parse(row.config_json);
    } catch {
      config = row.config_json;
    }
  }
  return {
    name,
    enabled: row ? Boolean(row.enabled) : true,
    defaultIntervalMs,
    config,
    lastPolledAt: row?.last_polled_at ?? null,
    lastRunSummary: lastSummary,
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
    views.push(toView(spec.name, spec.defaultIntervalMs, byName.get(spec.name) ?? null));
  }
  // Surface any historical triggers stored in the ledger that no longer exist
  // in the registry (e.g. a deprecated cohort) so the founder can disable them.
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    views.push(toView(row.name, 24 * 3600 * 1000, row));
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
  if (!stored) {
    const spec = TRIGGERS.find((t) => t.name === name);
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
