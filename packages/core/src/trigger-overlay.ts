import { getLedger } from "./ledger.ts";

type GetTrigger = (name: string) => { config_json: string | null } | null | undefined;

/**
 * The trigger a queue row came from, by its `source` (`find:<trigger>[:…]`).
 * Null when the source names no trigger. `post-funding` rows belong to the
 * `post-funding-auto` trigger.
 */
export function triggerNameForSource(source: string | null | undefined): string | null {
  const name = /^find:([^:]+)(?::|$)/.exec(source ?? "")?.[1];
  if (!name) return null;
  return name === "post-funding" ? "post-funding-auto" : name;
}

/**
 * The saved config of the trigger a row came from. Null when the source
 * names no trigger, the trigger is gone, or its config is empty or
 * unreadable: callers reading an opt-out flag treat that as the default.
 */
export function triggerConfigForSource(
  source: string | null | undefined,
  getTrigger: GetTrigger = (name) => getLedger().getTrigger(name),
): Record<string, unknown> | null {
  const name = triggerNameForSource(source);
  if (!name) return null;
  const trigger = getTrigger(name);
  if (!trigger || trigger.config_json == null) return null;
  try {
    const parsed: unknown = JSON.parse(trigger.config_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The member offer in force for a row: the trigger's own `memberOffer` when
 * its config sets one as text, else the workspace's. Trimmed; "" when neither
 * sets one, which the `multiplier` play treats as a refusal. The trigger
 * overrides the workspace the way `channels` does.
 */
export function effectiveMemberOffer(
  cfg: { memberOffer?: string | null },
  source: string | null | undefined,
  getTrigger: GetTrigger = (name) => getLedger().getTrigger(name),
): string {
  const fromTrigger = triggerConfigForSource(source, getTrigger)?.["memberOffer"];
  if (typeof fromTrigger === "string") return fromTrigger.trim();
  return (cfg.memberOffer ?? "").trim();
}

/**
 * Overlay a trigger's CURRENT sender-authored settings (edge, first-touch
 * format) onto a queued target, keyed by the row's `source`
 * (`find:<trigger>[:…]`). Used wherever a draft is generated from a stored
 * payload (queue drafting and cadence follow-ups alike) so an edit to the
 * trigger reaches rows already queued or in cadence without rewriting
 * history. Returns the target unchanged when the source names no trigger or
 * the trigger has no config; throws on an invalid config.
 */
export function resolveTriggerOverlay(
  target: Record<string, unknown>,
  source: string | null | undefined,
  getTrigger: GetTrigger = (name) => getLedger().getTrigger(name),
): Record<string, unknown> {
  const name = /^find:([^:]+)(?::|$)/.exec(source ?? "")?.[1];
  if (!name) return target;
  const trigger = getTrigger(triggerNameForSource(source) ?? name);
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
  // A row moved in from another workspace carries an edge derived for THIS
  // workspace on import (queue-rederive.ts). Its source still names the
  // trigger that found it elsewhere, so an empty edge on the same-named
  // trigger here must not blank it; a non-empty one still wins, as for any row.
  const moved = target["movedFrom"] != null;
  for (const key of ["yourEdge", "yourClaim"] as const) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    if (value !== null && typeof value !== "string") {
      throw new Error(`Invalid ${key} for trigger '${name}'; use text or clear the field.`);
    }
    if (moved && !(value ?? "").trim()) continue;
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
  // Angle assignment, read live for the same reason: `arm` assigns each
  // prospect's angle by an even per-prospect split; anything else (absent,
  // `fit`) keeps the fit classifier.
  if (config["angleAssignment"] === "arm") {
    resolved["angleAssignment"] = "arm";
  } else {
    delete resolved["angleAssignment"];
  }
  const split = config["firstTouchSplit"];
  if (typeof split === "number" && Number.isFinite(split)) {
    resolved["firstTouchSplit"] = split;
  } else {
    delete resolved["firstTouchSplit"];
  }
  return resolved;
}

/**
 * The row's active prospect offer carries its own angles (reasons it pays
 * back, written for that offer): when it does, they are the draft's angle
 * pool in place of the edge, joined the way a multi-angle edge is. Applied
 * after `resolveTriggerOverlay`, so the trigger's edge still reaches rows
 * without offer angles. The edge field keeps its name (`yourClaim` for a row
 * that has one), so every angle path (selection, Rotate, follow-ups, the
 * learning record) reads them unchanged. Never written back to the row.
 */
export function overlayOfferAngles(target: Record<string, unknown>): Record<string, unknown> {
  const offer = target["offer"];
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) return target;
  const raw = (offer as Record<string, unknown>)["angles"];
  const angles = Array.isArray(raw)
    ? raw.filter(
        (a): a is string => typeof a === "string" && a.trim().length > 0 && !a.includes("//"),
      )
    : [];
  if (angles.length === 0) return target;
  const field =
    typeof target["yourClaim"] === "string" && (target["yourClaim"] as string).trim()
      ? "yourClaim"
      : "yourEdge";
  return { ...target, [field]: angles.map((a) => a.trim()).join(" // ") };
}
