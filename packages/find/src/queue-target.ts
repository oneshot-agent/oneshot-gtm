import { getLedger, type QueueRow } from "@oneshot-gtm/core";

/** Refresh sender-authored edges at generation time without rewriting queue history. */
export function resolveQueueTarget(row: Pick<QueueRow, "payload_json" | "source">): unknown {
  const target: unknown = JSON.parse(row.payload_json);
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  const name = /^find:([^:]+)(?::|$)/.exec(row.source ?? "")?.[1];
  if (!name) return target;
  const trigger = getLedger().getTrigger(name === "post-funding" ? "post-funding-auto" : name);
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
  return resolved;
}
