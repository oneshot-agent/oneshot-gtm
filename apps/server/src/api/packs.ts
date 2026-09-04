import { getLedger } from "@oneshot-gtm/core";
import { checkReadiness, getPack, PACKS, storedTriggerConfig, TRIGGERS } from "@oneshot-gtm/find";
import type { PackApplyResult, PackView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function toPackView(pack: (typeof PACKS)[number]): PackView {
  return {
    id: pack.id,
    label: pack.label,
    ...(pack.summary ? { summary: pack.summary } : {}),
    buyerBrief: pack.buyerBrief,
    icpOneLiner: pack.icpOneLiner,
    triggers: Object.keys(pack.triggers),
    requires: pack.requires,
  };
}

export function listPacksRoute(req: Request): Response {
  return jsonResponse({ packs: PACKS.map(toPackView) }, 200, req);
}

/**
 * Apply an industry pack: merge each trigger patch OVER that trigger's
 * currently-stored config (falling back to its `defaultConfig` when no row
 * exists yet), then enable it. A pre-existing hand-tuned key (e.g.
 * `maxCostUsd`) survives because the patch is merged on top, not swapped in
 * wholesale. A patch naming a trigger absent from the registry is skipped
 * with a named reason rather than failing the whole apply. Never touches
 * `icpOneLiner` in config.json — the pack's proposed ICP rides back in the
 * response for the founder to accept separately.
 */
export async function applyPackRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = params["id"];
  if (!id) return jsonResponse({ error: "id required" }, 400, req);
  const pack = getPack(id);
  if (!pack) return jsonResponse({ error: `unknown pack '${id}'` }, 404, req);

  const ledger = getLedger();
  const applied: PackApplyResult["applied"] = [];
  const skipped: PackApplyResult["skipped"] = [];
  const toApply: Array<{ name: string; mergedConfig: Record<string, unknown> }> = [];

  for (const [name, patch] of Object.entries(pack.triggers)) {
    const spec = TRIGGERS.find((t) => t.name === name);
    if (!spec) {
      skipped.push({ name, reason: `unknown trigger '${name}' — not in the registry` });
      continue;
    }
    const stored = ledger.getTrigger(name);
    const baseConfig = storedTriggerConfig(stored, spec);
    const mergedConfig = { ...baseConfig, ...patch };
    toApply.push({ name, mergedConfig });
  }

  // One transaction for the whole batch: a later write throwing must not
  // leave earlier triggers in this pack half-applied (finding
  // PRRT_kwDOSKzrBs6fCBct) — either every trigger in `toApply` lands, or
  // none do.
  ledger.applyTriggerConfigs(
    toApply.map(({ name, mergedConfig }) => ({ name, configJson: JSON.stringify(mergedConfig) })),
  );

  for (const { name, mergedConfig } of toApply) {
    const spec = TRIGGERS.find((t) => t.name === name)!;
    const readiness = checkReadiness(spec, mergedConfig);
    applied.push({
      name,
      enabled: true,
      ready: readiness.ready,
      // An enabled-but-not-ready trigger (missing a `requires` key the pack
      // deliberately left blank) is the intended end state, not an error —
      // named plainly here so the UI can render it.
      notReadyReason: readiness.ready ? null : readiness.reason,
    });
  }

  const result: PackApplyResult = {
    id: pack.id,
    applied,
    skipped,
    proposedIcpOneLiner: pack.icpOneLiner,
  };
  return jsonResponse(result, 200, req);
}
