import { isAllowedDesignPartnerLoiBuyerType } from "@oneshot-gtm/plays";

/**
 * Buyer types `design-partner-loi` will actually draft for — mirrors that
 * play's own runtime allowlist (`isAllowedDesignPartnerLoiBuyerType`) so the
 * two can never drift apart. See issue #705: any finder that can surface a
 * person at a larger organization (enterprise/government/hardware) can be
 * configured to route its rows to `design-partner-loi`'s institutional
 * register instead of its own founder-to-founder play.
 */
export type DesignPartnerLoiBuyerType = "enterprise" | "government" | "hardware";

/** The play-routing keys a trigger config may carry, read by `resolvePlayRoute`. */
export interface PlayRouteConfig {
  /** `"design-partner-loi"` sends this finder's rows to that play instead of its own. Absent (default) = today's behaviour, unchanged. */
  play?: string;
  /** Required when `play` is `"design-partner-loi"`. Validated against that play's own buyer-type allowlist. */
  buyerType?: string;
}

export interface ResolvedPlayRoute {
  playName: "design-partner-loi";
  buyerType: DesignPartnerLoiBuyerType;
}

/**
 * Resolve whether a finder should route this run's rows to
 * `design-partner-loi`. Returns `null` when `play` isn't set to
 * `"design-partner-loi"` (fall back to the finder's own play — today's
 * behaviour) OR when `buyerType` fails the play's own allowlist (the
 * readiness gate is expected to have already refused an unready trigger
 * before this is reached; a direct/ad-hoc caller that skips readiness still
 * falls back safely here rather than mis-routing).
 */
export function resolvePlayRoute(cfg: {
  play?: unknown;
  buyerType?: unknown;
}): ResolvedPlayRoute | null {
  if (cfg.play !== "design-partner-loi") return null;
  if (typeof cfg.buyerType !== "string") return null;
  const buyerType = cfg.buyerType.trim().toLowerCase();
  if (!isAllowedDesignPartnerLoiBuyerType(buyerType)) return null;
  return { playName: "design-partner-loi", buyerType: buyerType as DesignPartnerLoiBuyerType };
}

/**
 * Extra readiness the `play`/`buyerType` routing keys impose, layered on top
 * of a trigger's own gates. Returns `null` (no additional restriction) when
 * `play` isn't `"design-partner-loi"` — a trigger with no routing configured
 * is exactly as ready as it was before this feature existed. `edgeKey` names
 * whichever config field feeds `DesignPartnerLoiTarget.yourEdge` for this
 * finder (`yourEdge` for most; `yourClaim` for hiring-signal).
 */
export function checkPlayRouteReadiness(
  cfg: Record<string, unknown>,
  edgeKey: "yourEdge" | "yourClaim",
): { ready: true } | { ready: false; reason: string } | null {
  if (cfg["play"] !== "design-partner-loi") return null;
  const edge = cfg[edgeKey];
  if (typeof edge !== "string" || edge.trim().length === 0) {
    return {
      ready: false,
      reason: `set \`${edgeKey}\` — required to route to design-partner-loi`,
    };
  }
  const buyerType = cfg["buyerType"];
  if (typeof buyerType !== "string" || !isAllowedDesignPartnerLoiBuyerType(buyerType)) {
    return {
      ready: false,
      reason:
        "set `buyerType` to 'enterprise', 'government', or 'hardware' to route to design-partner-loi",
    };
  }
  return { ready: true };
}

/**
 * Build the `DesignPartnerLoiTarget`-shaped payload a routed finder enqueues
 * instead of its own play's target shape. `title`/`linkedinUrl`/`phone` are
 * optional on the play's own target too, so they're only included when
 * present — matching the `...(x ? {x} : {})` convention every finder in this
 * package already follows for its own payload.
 */
export function buildDesignPartnerLoiPayload(input: {
  name: string;
  email: string;
  company: string;
  buyerType: DesignPartnerLoiBuyerType;
  yourEdge: string;
  title?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
}): Record<string, unknown> {
  return {
    name: input.name,
    email: input.email,
    company: input.company,
    buyerType: input.buyerType,
    yourEdge: input.yourEdge,
    ...(input.title ? { title: input.title } : {}),
    ...(input.linkedinUrl ? { linkedinUrl: input.linkedinUrl } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
  };
}

/**
 * Both plays a routed candidate could have landed under, for dedupe checks
 * that must survive a trigger's `play` being toggled after the candidate was
 * already queued once. `isQueueDuplicate`/`isDuplicate` are keyed by
 * (playName, dedupeKey); a finder that only ever checks its OWN current play
 * would let the same person back through the moment `play` flips (or flips
 * back) between runs. Checking the union of both plays' dedupe scope closes
 * that gap regardless of which play the row actually landed under.
 */
export function dedupePlayNames(ownPlayName: string): string[] {
  return [...new Set([ownPlayName, "design-partner-loi"])];
}
