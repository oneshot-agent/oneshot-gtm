import { getLedger } from "./ledger.ts";

/**
 * Overlay a trigger's CURRENT sender-authored settings (edge, first-touch
 * format) onto a queued target, keyed by the row's `source`
 * (`find:<trigger>[:…]`). Used wherever a draft is generated from a stored
 * payload — queue drafting and cadence follow-ups alike — so an edit to the
 * trigger reaches rows already queued or in cadence without rewriting
 * history. Returns the target unchanged when the source names no trigger or
 * the trigger has no config; throws on an invalid config.
 */
export function resolveTriggerOverlay(
  target: Record<string, unknown>,
  source: string | null | undefined,
  getTrigger: (name: string) => { config_json: string | null } | null | undefined = (name) =>
    getLedger().getTrigger(name),
): Record<string, unknown> {
  const name = /^find:([^:]+)(?::|$)/.exec(source ?? "")?.[1];
  if (!name) return target;
  const trigger = getTrigger(name === "post-funding" ? "post-funding-auto" : name);
  if (!trigger || trigger.config_json == null) return target;
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trigger.config_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    config = parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `Invalid configuration for trigger '${name}'; fix its config before generating.`,
    );
  }
  const resolved = { ...target } as Record<string, unknown>;
  for (const key of ["yourEdge", "yourClaim"] as const) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    if (value !== null && typeof value !== "string") {
      throw new Error(`Invalid ${key} for trigger '${name}'; use text or clear the field.`);
    }
    resolved[key] = value ?? "";
  }
  // First-touch format experiment settings, read at generation time like the
  // edge so turning a split on applies to rows already queued. The trigger's
  // current config is the only source: a value copied onto the payload is
  // dropped when the config no longer sets it (or sets it invalidly), so the
  // play falls back to its standard format, untracked.
  const format = config["firstTouchFormat"];
  if (format === "standard" || format === "brief" || format === "split") {
    resolved["firstTouchFormat"] = format;
  } else {
    delete resolved["firstTouchFormat"];
  }
  const split = config["firstTouchSplit"];
  if (typeof split === "number" && Number.isFinite(split)) {
    resolved["firstTouchSplit"] = split;
  } else {
    delete resolved["firstTouchSplit"];
  }
  return resolved;
}
